// Persistent threads in the SERVER store (R1-R6) — store AND HTTP contract.
//
// Coverage map:
//   - an unfocused submit opens a standalone host thread (fresh transcript) and
//     the roster exposes it with its transcript + invocation join;
//   - a submit to an idle thread is a CONTINUATION (transcript accumulates);
//   - a submit to a RUNNING thread is STEERED at the next model boundary (no
//     duplicate turn; the response names the owning turn);
//   - two thread lanes execute CONCURRENTLY with isolated event records;
//   - stop-one aborts only its lane (running or queued work) and stops the thread;
//   - delete purges owning turns/references/transcripts/persisted copies, rejects
//     running work (409) and the default conversation (400);
//   - turn indices stay monotonic and label seeds keep surviving labels stable;
//   - a same-root restart restores threads/turns/joins and never replays work;
//   - an old (pre-thread) document still loads;
//   - POST tasks `threadId`, POST thread cancel, DELETE thread over HTTP.
//
// Everything runs offline against a scripted preset: no provider, no network.
// The clock is pinned where timestamps are asserted; gates are explicit so every
// expected value is known before it is asserted.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessMessage, HarnessStreamEvent } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import type { HarnessRuntime } from './runtime';
import { createHarnessRuntime } from './runtime';
import { HarnessPersistence, readHarnessDatabase } from './persistence';
import { SessionError, SessionStore } from './sessions';
import type { SessionSnapshot, SessionThread } from './protocol';
import { listAgentResultBlocks, REFERENCED_RESULTS_FOOTER, REFERENCED_RESULTS_HEADER } from '../shared/agent-results';

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'super-secret-key',
    model: 'scripted/test'
};

// Store defaults carry the credential; the RUNTIME bootstrap reports only whether
// one exists (the key itself is never sent to a client).
const DEFAULTS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'super-secret-key',
    model: 'scripted/test'
};

const RUNTIME_DEFAULTS = {
    baseURL: DEFAULTS.baseURL,
    model: DEFAULTS.model,
    hasApiKey: true
};

type Deferred = { promise: Promise<void>; resolve: () => void };

const deferred = (): Deferred => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

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

const presetOf = (name: string, create: HarnessPreset['create']): HarnessPreset => ({
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

const lastUser = (messages: readonly HarnessMessage[]): string => {
    const users = messages.filter((message) => message.role === 'user');
    const last = users[users.length - 1];
    return last === undefined ? '' : String(last.content);
};

const transcript = (messages: readonly HarnessMessage[]): { role: string; content: string }[] =>
    messages.map((message) => ({ role: message.role, content: String(message.content) }));

// One scripted agent whose transport dispatches on the FIRST user prompt, logs
// overlap, records every request transcript, and waits on an explicit gate when
// the test created one for that prompt (abort-aware, so cancellation settles).
type Fixture = {
    preset: HarnessPreset;
    requests: HarnessMessage[][];
    log: string[];
    peak: () => number;
    gate: (prompt: string) => Deferred;
    started: (prompt: string) => Deferred;
};

const createFixture = (): Fixture => {
    const gates = new Map<string, Deferred>();
    const starts = new Map<string, Deferred>();
    const requests: HarnessMessage[][] = [];
    const log: string[] = [];
    let active = 0;
    let highest = 0;

    const gate = (prompt: string): Deferred => {
        const existing = gates.get(prompt);
        if (existing !== undefined) return existing;

        const created = deferred();
        gates.set(prompt, created);
        return created;
    };

    const started = (prompt: string): Deferred => {
        const existing = starts.get(prompt);
        if (existing !== undefined) return existing;

        const created = deferred();
        starts.set(prompt, created);
        return created;
    };

    const preset = presetOf('probe', (settings, progress) =>
        harness({
            agents: {
                probe: agent({
                    model: settings.model,
                    instruction: 'sys',
                    stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                        const prompt = lastUser(request.messages);
                        // A thread's FIRST prompt identifies the conversation; later
                        // turns of the same thread keep the last user message as key.
                        const key = request.messages.find((message) => message.role === 'user');
                        const routed = typeof key?.content === 'string' ? key.content : prompt;

                        requests.push(JSON.parse(JSON.stringify(request.messages)) as HarnessMessage[]);
                        active += 1;
                        highest = Math.max(highest, active);
                        log.push(`start:${prompt}`);
                        started(prompt).resolve();

                        try {
                            const held = gates.get(routed) ?? gates.get(prompt);
                            if (held !== undefined) {
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
                                    held.promise.then(resolve, reject);
                                });
                            }

                            yield { type: 'text', delta: `answer:${prompt}` };
                            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                        } finally {
                            log.push(`end:${prompt}`);
                            active -= 1;
                        }
                    }
                })
            },
            primary: 'probe',
            presets: false,
            report: { progress }
        })
    );

    return { preset, requests, log, peak: () => highest, gate, started };
};

const createStore = (
    presets: HarnessPreset[],
    persistence?: HarnessPersistence,
    database?: ReturnType<HarnessPersistence['load']>
): SessionStore =>
    new SessionStore(DEFAULTS, createHarnessRegistry(presets), undefined, {
        ...(persistence === undefined ? {} : { persistence }),
        ...(database === undefined ? {} : { database })
    });

const waitUntil = async (condition: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
        if (condition()) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    throw new Error('condition was not met in time');
};

// The exact assistant message the scripted transport commits.
const answerMessage = (text: string) => ({
    role: 'assistant' as const,
    content: text,
    reasoning: '',
    toolCalls: [],
    model: 'scripted/test',
    stopReason: 'stop' as const
});

describe('SessionStore persistent threads', () => {
    it('opens a standalone host thread for an unfocused submit and exposes its transcript', async () => {
        pinClock(1_000);
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        const task = store.enqueue(created.id, '  hello  ');
        // The 202 record names the thread it will run in and stays queued.
        expect(task.turn).toEqual({
            id: task.turn.id,
            index: 0,
            prompt: 'hello',
            threadId: 'thread-1',
            // R8: the first conversation of `probe` is PE1 (its root block, badge
            // and roster name all read this).
            threadLabel: 'PE1',
            status: 'queued',
            updatedAt: 1_000,
            events: [],
            eventTimes: []
        });

        await task.settled;
        await store.waitForIdle(created.id);

        const snapshot = store.get(created.id);
        expect(snapshot.turns).toEqual([
            {
                id: task.turn.id,
                index: 0,
                prompt: 'hello',
                threadId: 'thread-1',
                threadLabel: 'PE1',
                status: 'done',
                startedAt: 1_000,
                updatedAt: 1_000,
                // A host-thread ROOT run carries its invocation identity; the first
                // run of a fresh harness is invocation '1' (`input` on start only).
                events: [
                    {
                        type: 'start',
                        agent: 'probe',
                        model: 'scripted/test',
                        thread: { id: '1', input: 'hello' }
                    },
                    { type: 'text', agent: 'probe', delta: 'answer:hello', thread: { id: '1' } },
                    {
                        type: 'done',
                        agent: 'probe',
                        message: answerMessage('answer:hello'),
                        thread: { id: '1' }
                    }
                ],
                eventTimes: [1_000, 1_000, 1_000]
            }
        ]);

        // The roster is the join between the runtime record and this turn, and it
        // carries the conversation itself for a focused UI.
        expect(snapshot.threads).toEqual([
            {
                id: 'thread-1',
                agent: 'probe',
                origin: 'host',
                status: 'idle',
                sequence: 2,
                label: 'PE1',
                originTurnId: task.turn.id,
                originInvocationId: '1',
                invocationId: '1',
                messages: [
                    { role: 'system', content: 'sys' },
                    { role: 'user', content: 'hello' },
                    // A host-thread transcript is the compact conversation
                    // projection: assistant entries keep role + content only.
                    { role: 'assistant', content: 'answer:hello' }
                ]
            }
        ]);

        // The entry agent's DEFAULT conversation is untouched (the conversation
        // lives in the thread); label seeds record the conversation prefix.
        expect(transcript(snapshot.messages)).toEqual([{ role: 'system', content: 'sys' }]);
        expect(snapshot.labelSeeds).toBeUndefined();
    });

    // R8: the display name belongs to the CONVERSATION (agent code + per-agent
    // ordinal), is reused by a continuation, and is never re-minted after a
    // deletion. IDs stay opaque and are never parsed for the number.
    it('names conversations per agent, reuses the name on continuation and retires a deleted ordinal', async () => {
        pinClock(1_500);
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        const first = store.enqueue(created.id, 'one');
        await first.settled;
        const second = store.enqueue(created.id, 'two');
        await second.settled;
        const third = store.enqueue(created.id, 'three');
        await third.settled;

        // Three DISTINCT conversations: PE1, PE2, PE3 (not T1/T2/T3 and not one
        // number per invocation).
        expect(store.get(created.id).threads?.map((thread) => thread.label)).toEqual([
            'PE1',
            'PE2',
            'PE3'
        ]);

        // A continuation of PE2 repeats its label and consumes NO new ordinal.
        const continuation = store.enqueue(created.id, 'again', undefined, undefined, second.turn.threadId);
        expect(continuation.turn.threadId).toBe(second.turn.threadId);
        expect(continuation.turn.threadLabel).toBe('PE2');
        await continuation.settled;
        expect(store.get(created.id).threads?.map((thread) => thread.label)).toEqual([
            'PE1',
            'PE2',
            'PE3'
        ]);

        // Deleting PE1 retires its name: the next standalone conversation is PE4.
        store.deleteThread(created.id, first.turn.threadId as string);
        const fourth = store.enqueue(created.id, 'four');
        expect(fourth.turn.threadLabel).toBe('PE4');
        await fourth.settled;

        const after = store.get(created.id);
        expect(after.threads?.map((thread) => [thread.id, thread.label])).toEqual([
            [second.turn.threadId, 'PE2'],
            [third.turn.threadId, 'PE3'],
            [fourth.turn.threadId, 'PE4']
        ]);
    });

    it('continues an idle thread, preserving its transcript and index order', async () => {
        pinClock(2_000);
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        const first = store.enqueue(created.id, 'one');
        await first.settled;

        const second = store.enqueue(created.id, 'two', undefined, undefined, 'thread-1');
        expect(second.turn.threadId).toBe('thread-1');
        expect(second.turn.index).toBe(1);
        await second.settled;
        await store.waitForIdle(created.id);

        // Continuation, not a fresh block: the second request carries the first
        // exchange, in the SAME thread.
        expect(fixture.requests.map(transcript)).toEqual([
            [
                { role: 'system', content: 'sys' },
                { role: 'user', content: 'one' }
            ],
            [
                { role: 'system', content: 'sys' },
                { role: 'user', content: 'one' },
                { role: 'assistant', content: 'answer:one' },
                { role: 'user', content: 'two' }
            ]
        ]);

        const snapshot = store.get(created.id);
        expect(snapshot.threads).toHaveLength(1);
        expect(transcript(snapshot.threads![0].messages)).toEqual([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'one' },
            { role: 'assistant', content: 'answer:one' },
            { role: 'user', content: 'two' },
            { role: 'assistant', content: 'answer:two' }
        ]);
    });

    it('runs two thread lanes concurrently with isolated event records', async () => {
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        // Two standalone threads (each unfocused submit is serialized and completes).
        const seedOne = store.enqueue(created.id, 'seed-one');
        await seedOne.settled;
        const seedTwo = store.enqueue(created.id, 'seed-two');
        await seedTwo.settled;

        fixture.gate('left');
        fixture.gate('right');

        const left = store.enqueue(created.id, 'left', undefined, undefined, 'thread-1');
        await fixture.started('left').promise;
        const right = store.enqueue(created.id, 'right', undefined, undefined, 'thread-2');
        await fixture.started('right').promise;

        // BOTH requests are in flight: the lanes do not share the legacy gate.
        expect(fixture.peak()).toBe(2);

        fixture.gate('left').resolve();
        fixture.gate('right').resolve();
        await left.settled;
        await right.settled;
        await store.waitForIdle(created.id);

        const snapshot = store.get(created.id);
        const deltas = (turnId: string): string[] =>
            snapshot.turns
                .find((turn) => turn.id === turnId)!
                .events.filter((event) => event.type === 'text')
                .map((event) => (event as { delta: string }).delta);

        // Each lane recorded ONLY its own text.
        expect(deltas(left.turn.id)).toEqual(['answer:left']);
        expect(deltas(right.turn.id)).toEqual(['answer:right']);
        expect(snapshot.turns.map((turn) => `${turn.index}:${turn.threadId}:${turn.status}`)).toEqual([
            '0:thread-1:done',
            '1:thread-2:done',
            '2:thread-1:done',
            '3:thread-2:done'
        ]);
    });

    it('steers a running thread without recording a duplicate turn', async () => {
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        fixture.gate('start');
        const running = store.enqueue(created.id, 'start');
        await fixture.started('start').promise;

        const steered = store.enqueue(created.id, 'more', undefined, undefined, 'thread-1');
        // Explicit steering marker; `turn` is the turn that owns the run.
        expect(steered.steered).toBe(true);
        expect(steered.turn.id).toBe(running.turn.id);
        expect(store.get(created.id).turns).toHaveLength(1);
        await steered.settled;

        fixture.gate('start').resolve();
        await fixture.started('more').promise;
        await running.settled;
        await store.waitForIdle(created.id);

        // The steered text became the NEXT user message at the model boundary.
        expect(fixture.requests.map(transcript)).toEqual([
            [
                { role: 'system', content: 'sys' },
                { role: 'user', content: 'start' }
            ],
            [
                { role: 'system', content: 'sys' },
                { role: 'user', content: 'start' },
                { role: 'assistant', content: 'answer:start' },
                { role: 'user', content: 'more' }
            ]
        ]);

        const snapshot = store.get(created.id);
        expect(snapshot.turns).toHaveLength(1);
        expect(
            snapshot.turns[0].events
                .filter((event) => event.type === 'text')
                .map((event) => (event as { delta: string }).delta)
        ).toEqual(['answer:start', 'answer:more']);
    });

    it('rejects a blank or unknown thread id and steers/continues only real threads', async () => {
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        expect(() => store.enqueue(created.id, 'x', undefined, undefined, '   ')).toThrow(
            '`threadId` must be a non-empty string when present.'
        );
        expect(() => store.enqueue(created.id, 'x', undefined, undefined, 7)).toThrow(
            '`threadId` must be a non-empty string when present.'
        );

        // The thread must EXIST before it can be addressed.
        const seed = store.enqueue(created.id, 'seed');
        await seed.settled;

        const task = store.enqueue(created.id, 'known', undefined, undefined, 'thread-1');
        expect(task.turn.threadId).toBe('thread-1');
        await task.settled;

        expect(() => store.enqueue(created.id, 'x', undefined, undefined, 'thread-404')).toThrow(
            'Unknown thread "thread-404".'
        );
    });

    it('stops one thread (running and queued work) and leaves the legacy run alone', async () => {
        pinClock(3_000);
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        const seed = store.enqueue(created.id, 'seed');
        await seed.settled;

        // Hold the exclusive gate with a legacy run, so the lane submit QUEUES.
        fixture.gate('legacy');
        const legacy = store.run(created.id, 'legacy', async () => {});
        await fixture.started('legacy').promise;

        const queued = store.enqueue(created.id, 'waiting', undefined, undefined, 'thread-1');
        expect(queued.turn.status).toBe('queued');

        const stopped = store.cancelThread(created.id, 'thread-1');
        expect(stopped.cancelled).toBe(true);
        expect(stopped.session.threads).toEqual([
            expect.objectContaining({ id: 'thread-1', status: 'stopped' }) as unknown as SessionThread
        ]);
        expect(
            stopped.session.turns.map((turn) => `${turn.index}:${turn.prompt}:${turn.status}`)
        ).toEqual(['0:seed:done', '1:legacy:running', '2:waiting:cancelled']);
        await queued.settled;

        fixture.gate('legacy').resolve();
        await legacy;
        await store.waitForIdle(created.id);

        // The stopped thread never started its queued turn.
        expect(fixture.log).toEqual(['start:seed', 'end:seed', 'start:legacy', 'end:legacy']);
    });

    it('aborts a running thread and reports it cancelled and stopped', async () => {
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        fixture.gate('long');
        const running = store.enqueue(created.id, 'long');
        await fixture.started('long').promise;

        const stopped = store.cancelThread(created.id, 'thread-1', 'owner stopped it');
        expect(stopped.cancelled).toBe(true);
        expect(stopped.session.threads![0]).toEqual(
            expect.objectContaining({ id: 'thread-1', status: 'stopped' })
        );

        fixture.gate('long').resolve();
        await running.settled;
        await store.waitForIdle(created.id);

        const final = store.get(created.id);
        expect(final.turns[0].status).toBe('cancelled');
        expect(final.status).toBe('error');
        expect(final.lastError).toBe('The run was cancelled.');

        expect(() => store.cancelThread(created.id, 'thread-404')).toThrow('Unknown thread "thread-404".');
        expect(() => store.cancelThread('missing', 'thread-1')).toThrow('Unknown session "missing".');
    });

    it('stops every host thread and backlog on cancel { all: true }', async () => {
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        // F1: two plain submits run CONCURRENTLY in their own lanes; stop-all must
        // stop both conversations and abort both runs.
        fixture.gate('active');
        fixture.gate('sibling');
        const active = store.enqueue(created.id, 'active');
        await fixture.started('active').promise;
        const sibling = store.enqueue(created.id, 'sibling');
        await fixture.started('sibling').promise;
        expect(fixture.peak()).toBe(2);

        expect(store.cancel(created.id, { all: true })).toBe(true);

        fixture.gate('active').resolve();
        fixture.gate('sibling').resolve();
        await active.settled;
        await sibling.settled;
        await store.waitForIdle(created.id);

        const final = store.get(created.id);
        expect(final.turns.map((turn) => turn.status)).toEqual(['cancelled', 'cancelled']);
        expect(final.status).toBe('error');
        expect(final.lastError).toBe('The run was cancelled.');
        expect(final.threads!.map((thread) => thread.status)).toEqual(['stopped', 'stopped']);
        expect(fixture.log).toEqual([
            'start:active',
            'start:sibling',
            'end:active',
            'end:sibling'
        ]);
    });
});

// ---------------------------------------------------------------------------
// Deletion: purge, statuses, monotonic indices, stable labels, persistence
// ---------------------------------------------------------------------------

const threadOf = (snapshot: SessionSnapshot, turnId: string): string => {
    const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
    if (turn?.threadId === undefined) throw new Error(`turn ${turnId} has no thread`);
    return turn.threadId;
};

describe('SessionStore thread deletion', () => {
    it('rejects running work (409), the default conversation (400), and unknown ids (404)', async () => {
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        const seed = store.enqueue(created.id, 'seed');
        await seed.settled;

        // Hold a LANE run in thread-1 so its record is live.
        fixture.gate('hold');
        const held = store.enqueue(created.id, 'hold', undefined, undefined, 'thread-1');
        await fixture.started('hold').promise;

        expect(() => store.deleteThread(created.id, 'thread-1')).toThrow(SessionError);
        expect(() => store.deleteThread(created.id, 'thread-1')).toThrow(
            'Thread "thread-1" still has live work; wait for it to stop before deleting it.'
        );
        expect(() => store.deleteThread(created.id, 'thread-404')).toThrow(
            'Unknown thread "thread-404".'
        );
        expect(() => store.deleteThread(created.id, 'agent:probe')).toThrow(
            'Thread "agent:probe" is the agent\'s own conversation and cannot be deleted; use reset to clear the session.'
        );

        store.cancel(created.id, { all: true });
        fixture.gate('hold').resolve();
        await held.settled;
        await store.waitForIdle(created.id);

        // A stopped, idle thread deletes cleanly and its turns/transcript go with it.
        const deleted = store.deleteThread(created.id, 'thread-1');
        expect(deleted.threads).toBeUndefined();
        expect(deleted.turns).toEqual([]);
    });

    it('keeps indices monotonic and surviving labels stable across a deletion', async () => {
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        const one = store.enqueue(created.id, 'one');
        await one.settled;
        const two = store.enqueue(created.id, 'two');
        await two.settled;
        const three = store.enqueue(created.id, 'three');
        await three.settled;
        await store.waitForIdle(created.id);

        const before = store.get(created.id);
        // Agent `probe` -> code `PE`; occurrences are conversation-scoped.
        expect(
            listAgentResultBlocks(
                before.turns.map((turn) => ({
                    ...turn,
                    ...(before.labelSeeds?.[turn.id] === undefined
                        ? {}
                        : { labels: before.labelSeeds[turn.id] })
                }))
            ).map((block) => block.label)
        ).toEqual(['PE1', 'PE2', 'PE3']);

        store.deleteThread(created.id, threadOf(before, one.turn.id));

        const after = store.get(created.id);
        expect(after.turns.map((turn) => `${turn.index}:${turn.prompt}`)).toEqual([
            '1:two',
            '2:three'
        ]);
        // Seeds survive the deletion: the surviving blocks keep PE2/PE3.
        expect(
            listAgentResultBlocks(
                after.turns.map((turn) => ({
                    ...turn,
                    ...(after.labelSeeds?.[turn.id] === undefined
                        ? {}
                        : { labels: after.labelSeeds[turn.id] })
                }))
            ).map((block) => block.label)
        ).toEqual(['PE2', 'PE3']);

        // A typed reference to the surviving #PE2 still resolves to that turn.
        const reuse = store.enqueue(created.id, 'reuse #PE2');
        await reuse.settled;
        await store.waitForIdle(created.id);

        const reuseTurn = store.get(created.id).turns.find((turn) => turn.id === reuse.turn.id)!;
        expect(reuseTurn.references).toEqual([{ turnId: two.turn.id, label: 'PE2' }]);
        expect(reuseTurn.status).toBe('done');
        expect(fixture.requests).toHaveLength(4);
        expect(lastUser(fixture.requests[3])).toBe(
            [
                'reuse #PE2',
                '',
                REFERENCED_RESULTS_HEADER,
                `--- #PE2 | agent probe | turn ${two.turn.id} ---`,
                'answer:two',
                '--- end #PE2 ---',
                REFERENCED_RESULTS_FOOTER
            ].join('\n')
        );

        // A reference to the deleted turn is refused before anything mutates.
        expect(() =>
            store.enqueue(created.id, 'gone', undefined, [{ turnId: one.turn.id, label: 'PE1' }])
        ).toThrow(`Referenced turn "${one.turn.id}" does not exist in this session.`);

        // The index high-water mark never reuses a deleted turn's index.
        const next = store.enqueue(created.id, 'next');
        expect(next.turn.index).toBe(4);
        await next.settled;
    });

    it('removes the deleted thread and its turns from the persisted document', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't4-threads-'));
        const fixture = createFixture();
        const persistence = new HarnessPersistence(root);
        const store = createStore([fixture.preset], persistence);
        const created = store.create('probe');

        const one = store.enqueue(created.id, 'one');
        await one.settled;
        const two = store.enqueue(created.id, 'two');
        await two.settled;
        await store.waitForIdle(created.id);

        const deleted = store.deleteThread(created.id, threadOf(store.get(created.id), one.turn.id));
        expect(deleted.threads!.map((thread) => thread.id)).toEqual([threadOf(deleted, two.turn.id)]);

        const reloaded = createStore([fixture.preset], persistence, persistence.load()).get(created.id);
        expect(reloaded.turns.map((turn) => turn.prompt)).toEqual(['two']);
        expect(reloaded.threads!.map((thread) => thread.id)).toEqual([threadOf(reloaded, two.turn.id)]);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
});

// ---------------------------------------------------------------------------
// Persistence: restore threads/joins, never replay, read an old document
// ---------------------------------------------------------------------------

describe('SessionStore thread persistence', () => {
    it('restores threads, turns, and invocation joins, and never replays lane work', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't4-threads-'));
        const fixture = createFixture();
        const persistence = new HarnessPersistence(root);

        const first = createStore([fixture.preset], persistence);
        const created = first.create('probe');

        const done = first.enqueue(created.id, 'kept');
        await done.settled;

        // Hold a LEGACY run so a lane submit stays queued at "crash" time.
        fixture.gate('legacy');
        void first.run(created.id, 'legacy', async () => {});
        await fixture.started('legacy').promise;
        const queued = first.enqueue(created.id, 'pending-lane', undefined, undefined, 'thread-1');
        expect(queued.turn.status).toBe('queued');

        // Simulate a crash: a FRESH store over the same root, no dispose.
        const second = createStore([fixture.preset], persistence, persistence.load());
        const restored = second.get(created.id);

        // Recovery policy: in-flight work is interrupted and never replayed; an
        // ACCEPTED-BUT-UNSTARTED turn is preserved as 'queued' (paused backlog) with
        // its prompt and thread association (F1), not discarded.
        expect(restored.turns.map((turn) => `${turn.prompt}:${turn.status}:${turn.threadId}`)).toEqual([
            'kept:done:thread-1',
            'legacy:error:undefined',
            'pending-lane:queued:thread-1'
        ]);
        expect(restored.queueDepth).toBe(1);

        // The thread and its transcript survive, with the invocation join.
        expect(restored.threads).toEqual([
            {
                id: 'thread-1',
                agent: 'probe',
                origin: 'host',
                status: 'idle',
                sequence: 2,
                // R8: the conversation's display name survives the restart; ids
                // stay opaque (`thread-1`) and are never read as labels.
                label: 'PE1',
                originTurnId: done.turn.id,
                originInvocationId: '1',
                invocationId: '1',
                messages: [
                    { role: 'system', content: 'sys' },
                    { role: 'user', content: 'kept' },
                    { role: 'assistant', content: 'answer:kept' }
                ]
            }
        ]);

        // The paused backlog is NOT replayed on restart: no request was made for it.
        expect(fixture.requests).toHaveLength(2);

        // An explicit submit to that SAME thread drains the paused turn FIRST (FIFO),
        // with its persisted prompt, then runs the new input as a continuation.
        const kick = second.enqueue(created.id, 'after restart', undefined, undefined, 'thread-1');
        await kick.settled;
        await second.waitForIdle(created.id);

        const drained = second.get(created.id);
        expect(drained.queueDepth).toBeUndefined();
        expect(drained.turns.map((turn) => `${turn.index}:${turn.prompt}:${turn.status}`)).toEqual([
            '0:kept:done',
            '1:legacy:error',
            '2:pending-lane:done',
            '3:after restart:done'
        ]);
        expect(fixture.requests.slice(2).map(transcript)).toEqual([
            [
                { role: 'system', content: 'sys' },
                { role: 'user', content: 'kept' },
                { role: 'assistant', content: 'answer:kept' },
                { role: 'user', content: 'pending-lane' }
            ],
            [
                { role: 'system', content: 'sys' },
                { role: 'user', content: 'kept' },
                { role: 'assistant', content: 'answer:kept' },
                { role: 'user', content: 'pending-lane' },
                { role: 'assistant', content: 'answer:pending-lane' },
                { role: 'user', content: 'after restart' }
            ]
        ]);

        first.dispose();
        second.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('reads a pre-thread document (no thread fields) without failing', () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't4-threads-'));
        const fixture = createFixture();
        const persistence = new HarnessPersistence(root);
        const store = createStore([fixture.preset], persistence);
        const created = store.create('probe');
        const task = store.enqueue(created.id, 'one');
        expect(task.turn.threadId).toBe('thread-1');
        store.dispose();

        const document = JSON.parse(fs.readFileSync(persistence.file, 'utf8')) as {
            sessions: {
                threadSequence?: unknown;
                labelSeeds?: unknown;
                turnInvocations?: unknown;
                turns: { threadId?: unknown }[];
                core: { threads?: unknown; threadSequence?: unknown };
            }[];
        };
        for (const session of document.sessions) {
            delete session.threadSequence;
            delete session.labelSeeds;
            delete session.turnInvocations;
            delete session.core.threads;
            delete session.core.threadSequence;
            for (const turn of session.turns) delete turn.threadId;
        }
        fs.writeFileSync(persistence.file, JSON.stringify(document, null, 2), 'utf8');

        const old = readHarnessDatabase(JSON.parse(fs.readFileSync(persistence.file, 'utf8')));
        expect(old.sessions).toHaveLength(1);
        // The turn was in flight when the store was disposed, so the document
        // records it as running (the reload marks it interrupted below).
        expect(old.sessions[0].turns.map((turn) => turn.status)).toEqual(['running']);
        expect(old.sessions[0].turns[0].threadId).toBeUndefined();
        expect(old.sessions[0].threadSequence).toBeUndefined();

        // A store built from it still starts (threads are simply absent) and the
        // interrupted turn follows the existing recovery policy.
        const reloaded = createStore([fixture.preset], persistence, persistence.load()).get(created.id);
        expect(reloaded.threads).toBeUndefined();
        expect(reloaded.turns.map((turn) => turn.status)).toEqual(['error']);

        fs.rmSync(root, { recursive: true, force: true });
    });
});

// ---------------------------------------------------------------------------
// HTTP contract: task threadId, thread cancel, thread delete
// ---------------------------------------------------------------------------

const callApi = (runtime: HarnessRuntime, method: string, pathname: string, body: unknown = {}) =>
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

const jsonOf = async <T>(result: Awaited<ReturnType<typeof callApi>>): Promise<{ status: number; body: T }> => {
    if (result.kind !== 'json') throw new Error('expected JSON');
    return { status: result.status, body: result.body as T };
};

describe('thread HTTP contract', () => {
    const runtimeOf = (presets: HarnessPreset[]): HarnessRuntime =>
        createHarnessRuntime({
            settings: SETTINGS,
            defaults: RUNTIME_DEFAULTS,
            store: new SessionStore(SETTINGS, createHarnessRegistry(presets)),
            loadEnvironment: false
        });

    it('accepts threadId on /tasks, reports steering, and serves cancel/delete routes', async () => {
        const fixture = createFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'probe');

        // Unfocused submit: 202 `{session, turn}` with the new thread id.
        const accepted = await jsonOf<{ session: SessionSnapshot; turn: { threadId?: string; id: string } }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, { input: 'first' })
        );
        expect(accepted.status).toBe(202);
        expect(accepted.body.turn.threadId).toBe('thread-1');
        await runtime.store.waitForIdle(id);

        // Continuation through the SAME thread keeps the envelope (no `steered`).
        const continued = await jsonOf<{ turn: { threadId?: string; index: number }; steered?: true }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
                input: 'second',
                threadId: 'thread-1'
            })
        );
        expect(continued.status).toBe(202);
        expect(continued.body.turn).toEqual(
            expect.objectContaining({ threadId: 'thread-1', index: 1 })
        );
        expect(continued.body.steered).toBeUndefined();
        await runtime.store.waitForIdle(id);

        // Steering a RUNNING thread: `steered: true` and the owning turn.
        fixture.gate('third');
        const running = await jsonOf<{ turn: { id: string } }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
                input: 'third',
                threadId: 'thread-1'
            })
        );
        await fixture.started('third').promise;

        const steered = await jsonOf<{ turn: { id: string }; steered?: true }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
                input: 'steered text',
                threadId: 'thread-1'
            })
        );
        expect(steered.status).toBe(202);
        expect(steered.body.steered).toBe(true);
        expect((steered.body as { steeredThreadId?: string }).steeredThreadId).toBe('thread-1');
        expect(steered.body.turn.id).toBe(running.body.turn.id);

        // Unknown thread id over HTTP is a 404.
        const unknown = await jsonOf<{ error: { message: string } }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
                input: 'x',
                threadId: 'thread-404'
            })
        );
        expect(unknown).toEqual({ status: 404, body: { error: { message: 'Unknown thread "thread-404".' } } });

        // Stop ONE thread: `{cancelled, session}`.
        const cancelled = await jsonOf<{ cancelled: boolean; session: SessionSnapshot }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/threads/thread-1/cancel`)
        );
        expect(cancelled.status).toBe(200);
        expect(cancelled.body.cancelled).toBe(true);
        expect(cancelled.body.session.threads![0].status).toBe('stopped');

        fixture.gate('third').resolve();
        await runtime.store.waitForIdle(id);

        // A stopped thread deletes; a second delete is a 404.
        const deleted = await jsonOf<{ deleted: true; session: SessionSnapshot }>(
            await callApi(runtime, 'DELETE', `/v1/harness/sessions/${id}/threads/thread-1`)
        );
        expect(deleted).toEqual({
            status: 200,
            body: { deleted: true, session: deleted.body.session }
        });
        expect(deleted.body.session.turns).toEqual([]);
        expect(deleted.body.session.threads).toBeUndefined();

        const missing = await jsonOf<{ error: { message: string } }>(
            await callApi(runtime, 'DELETE', `/v1/harness/sessions/${id}/threads/thread-1`)
        );
        expect(missing).toEqual({ status: 404, body: { error: { message: 'Unknown thread "thread-1".' } } });
    });

    it('keeps /cancel { all: true } and the legacy cancel envelope', async () => {
        const fixture = createFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'probe');

        fixture.gate('active');
        void callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, { input: 'active' });
        await fixture.started('active').promise;

        const all = await jsonOf<{ cancelled: boolean }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/cancel`, { all: true })
        );
        expect(all).toEqual({ status: 200, body: { cancelled: true } });

        fixture.gate('active').resolve();
        await runtime.store.waitForIdle(id);
    });
});

// ---------------------------------------------------------------------------
// Delegated child conversations on the server roster
// ---------------------------------------------------------------------------

describe('delegated child threads', () => {
    const delegationPreset = (): HarnessPreset => {
        let leadRequests = 0;

        return {
            name: 'lead',
            title: 'lead',
            description: 'lead + helper',
            requiresEndpoint: false,
            primary: 'lead',
            subagents: ['helper'],
            agents: ['lead', 'helper'],
            tools: [],
            builtin: true,
            editable: true,
            create: (settings, progress) =>
                harness({
                    agents: {
                        lead: agent({
                            model: settings.model,
                            instruction: 'lead',
                            stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
                                leadRequests += 1;

                                if (leadRequests === 1) {
                                    yield {
                                        type: 'done',
                                        stopReason: 'tool_calls',
                                        toolCalls: [
                                            {
                                                id: 'delegate-1',
                                                name: 'agentDelegate',
                                                arguments: JSON.stringify({
                                                    agent: 'helper',
                                                    input: 'child work'
                                                })
                                            }
                                        ]
                                    };
                                    return;
                                }

                                yield { type: 'text', delta: 'lead answer' };
                                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                            }
                        }),
                        helper: agent({
                            model: settings.model,
                            instruction: 'helper',
                            stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
                                yield { type: 'text', delta: 'helper answer' };
                                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                            }
                        })
                    },
                    primary: 'lead',
                    subagents: ['helper'],
                    presets: false,
                    report: { progress }
                })
        };
    };

    it('exposes the child conversation with its owner link and invocation mapping, and persists it', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't4-threads-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore([delegationPreset()], persistence);
        const created = store.create('lead');

        const task = store.enqueue(created.id, 'delegate please');
        await task.settled;
        await store.waitForIdle(created.id);

        const snapshot = store.get(created.id);
        expect(snapshot.threads!.map((thread) => ({
            id: thread.id,
            agent: thread.agent,
            owner: thread.ownerThreadId,
            invocation: thread.invocationId,
            originTurn: thread.originTurnId,
            originInvocation: thread.originInvocationId
        }))).toEqual([
            {
                id: 'thread-1',
                agent: 'lead',
                owner: undefined,
                invocation: '1',
                originTurn: task.turn.id,
                originInvocation: '1'
            },
            {
                id: 'thread-2',
                agent: 'helper',
                owner: 'thread-1',
                invocation: '2',
                // The child's work is recorded inside its parent's turn; it has no
                // turn of its own, so no originTurnId.
                originTurn: undefined,
                originInvocation: undefined
            }
        ]);

        expect(transcript(snapshot.threads![1].messages)).toEqual([
            { role: 'system', content: 'helper' },
            { role: 'user', content: 'child work' },
            { role: 'assistant', content: 'helper answer' }
        ]);

        // The child's events carry its invocation id, which the roster maps onto
        // the persistent conversation.
        const childFrames = snapshot.turns[0].events.filter(
            (event) => event.type === 'start' && event.agent === 'helper'
        );
        expect(childFrames).toEqual([
            {
                type: 'start',
                agent: 'helper',
                model: 'scripted/test',
                thread: { id: '2', parentId: '1', callId: 'delegate-1', input: 'child work' }
            }
        ]);

        // Restart: both conversations and the link survive.
        const restored = createStore([delegationPreset()], persistence, persistence.load()).get(created.id);
        expect(restored.threads!.map((thread) => `${thread.id}:${thread.ownerThreadId ?? '-'}:${thread.invocationId}`)).toEqual([
            'thread-1:-:1',
            'thread-2:thread-1:2'
        ]);
        expect(transcript(restored.threads![1].messages)).toEqual([
            { role: 'system', content: 'helper' },
            { role: 'user', content: 'child work' },
            { role: 'assistant', content: 'helper answer' }
        ]);

        // Deleting the owner removes the linked child with it.
        const deleted = store.deleteThread(created.id, 'thread-1');
        expect(deleted.threads).toBeUndefined();
        expect(deleted.turns).toEqual([]);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('purges the deleted child result from the persisted agent-result registry (F6)', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't4-threads-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore([delegationPreset()], persistence);
        const created = store.create('lead');

        const task = store.enqueue(created.id, 'delegate please');
        await task.settled;
        await store.waitForIdle(created.id);

        const persistedIds = (): string[] => {
            const document = JSON.parse(fs.readFileSync(persistence.file, 'utf8')) as {
                sessions: { core: { agentResults?: { invocationId: string }[] } }[];
            };

            return (document.sessions[0].core.agentResults ?? []).map(
                (result) => result.invocationId
            );
        };

        // Both the root ('1') and the delegated child ('2') results are durable.
        expect(persistedIds()).toEqual(['1', '2']);

        store.deleteThread(created.id, 'thread-2');

        // The saved registry loses EXACTLY the child's result; the root survives.
        expect(persistedIds()).toEqual(['1']);
        expect(store.get(created.id).turns).toHaveLength(1);
        // History is not rewritten: the parent turn still records the child's frames.
        expect(
            store
                .get(created.id)
                .turns[0].events.some((event) => event.type === 'start' && event.agent === 'helper')
        ).toBe(true);

        store.dispose();

        // Restart: the purged invocation is not addressable, the survivor is.
        const reloaded = createStore([delegationPreset()], persistence, persistence.load());
        await expect(
            reloaded.callTool(created.id, 'agentResult', { agent: 'helper', invocationId: '2' })
        ).rejects.toThrow('No result "2" is available for agent "helper".');
        expect(
            await reloaded.callTool(created.id, 'agentResult', { agent: 'lead', invocationId: '1' })
        ).toMatchObject({ agent: 'lead', invocationId: '1', status: 'completed' });

        reloaded.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
});

// ---------------------------------------------------------------------------
// Failure rollback: a rejected write leaves memory and disk consistent
// ---------------------------------------------------------------------------

describe('thread persistence rollback', () => {
    it('rolls back an accepted submit (including its new thread) when the save fails', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't4-threads-'));
        const fixture = createFixture();
        const persistence = new HarnessPersistence(root);
        const store = createStore([fixture.preset], persistence);
        const created = store.create('probe');

        const save = vi.spyOn(persistence, 'save').mockImplementation(() => {
            throw new Error('disk full');
        });

        // `enqueue` validates/persists synchronously, so the failure is a throw.
        let submitFailure: unknown;
        try {
            store.enqueue(created.id, 'lost');
        } catch (error) {
            submitFailure = error;
        }
        expect(submitFailure).toMatchObject({ status: 500 });

        // Nothing was accepted: no turn, no thread, no pending queue.
        const snapshot = store.get(created.id);
        expect(snapshot.turns).toEqual([]);
        expect(snapshot.threads).toBeUndefined();
        expect(snapshot.queueDepth).toBeUndefined();

        // The abandoned thread is gone (no roster entry above), and its id stays
        // RETIRED: the runtime never reuses a minted thread id, so the next accepted
        // submit is thread-2.
        save.mockRestore();
        const next = store.enqueue(created.id, 'kept');
        expect(next.turn.threadId).toBe('thread-2');
        await next.settled;
        await store.waitForIdle(created.id);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('keeps the thread and its turns when a delete cannot be persisted', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't4-threads-'));
        const fixture = createFixture();
        const persistence = new HarnessPersistence(root);
        const store = createStore([fixture.preset], persistence);
        const created = store.create('probe');

        const task = store.enqueue(created.id, 'one');
        await task.settled;
        await store.waitForIdle(created.id);

        const save = vi.spyOn(persistence, 'save').mockImplementation(() => {
            throw new Error('disk full');
        });

        let deleteFailure: unknown;
        try {
            store.deleteThread(created.id, 'thread-1');
        } catch (error) {
            deleteFailure = error;
        }
        expect(deleteFailure).toMatchObject({ status: 500 });

        // The failed delete changed NOTHING: the live record and the thread exist.
        const snapshot = store.get(created.id);
        expect(snapshot.turns).toHaveLength(1);
        expect(snapshot.threads!.map((thread) => thread.id)).toEqual(['thread-1']);

        // Once writes work again the same delete succeeds and is durable.
        save.mockRestore();
        expect(store.deleteThread(created.id, 'thread-1').turns).toEqual([]);
        const reloaded = createStore([fixture.preset], persistence, persistence.load()).get(created.id);
        expect(reloaded.turns).toEqual([]);
        expect(reloaded.threads).toBeUndefined();

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
});

// ---------------------------------------------------------------------------
// F2: a reference is a LINK, never ownership
// ---------------------------------------------------------------------------

describe('thread reference edges', () => {
    it('links without owning: stopping or deleting the source keeps the connected conversation', async () => {
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        const source = store.enqueue(created.id, 'source');
        await source.settled;

        const linked = store.enqueue(created.id, 'connected', undefined, [
            { turnId: source.turn.id, label: 'PE1' }
        ]);
        await linked.settled;
        await store.waitForIdle(created.id);

        const before = store.get(created.id);
        const linkedThread = before.threads!.find((thread) => thread.id === linked.turn.threadId)!;

        // No ownership from the reference; the relation is an edge.
        expect(linkedThread.ownerThreadId).toBeUndefined();
        expect(linkedThread.connectedThreadIds).toEqual([source.turn.threadId]);
        expect(linkedThread.references).toEqual([{ turnId: source.turn.id, label: 'PE1' }]);

        // Stopping the SOURCE conversation never aborts the connected one.
        expect(store.cancelThread(created.id, source.turn.threadId!)).toEqual({
            cancelled: false,
            session: expect.anything()
        });
        const afterStop = store.get(created.id);
        expect(afterStop.turns.map((turn) => `${turn.prompt}:${turn.status}`)).toEqual([
            'source:done',
            'connected:done'
        ]);
        expect(afterStop.threads!.find((thread) => thread.id === source.turn.threadId)!.status).toBe(
            'stopped'
        );
        expect(afterStop.threads!.find((thread) => thread.id === linked.turn.threadId)!.status).toBe(
            'idle'
        );

        // Deleting the source strips the dangling LINK but keeps the conversation,
        // its turn, and its transcript.
        const deleted = store.deleteThread(created.id, source.turn.threadId!);
        expect(deleted.turns.map((turn) => `${turn.prompt}:${turn.status}`)).toEqual(['connected:done']);
        const survivor = deleted.threads!.find((thread) => thread.id === linked.turn.threadId)!;
        expect(survivor.status).toBe('idle');
        expect(survivor.references).toBeUndefined();
        expect(survivor.connectedThreadIds).toBeUndefined();
        // The conversation (and its transcript, including the composed reference
        // context it was run with) survives untouched.
        const composed = [
            'connected',
            '',
            REFERENCED_RESULTS_HEADER,
            `--- #PE1 | agent probe | turn ${source.turn.id} ---`,
            'answer:source',
            '--- end #PE1 ---',
            REFERENCED_RESULTS_FOOTER
        ].join('\n');
        expect(transcript(survivor.messages)).toEqual([
            { role: 'system', content: 'sys' },
            { role: 'user', content: composed },
            { role: 'assistant', content: `answer:${composed}` }
        ]);
    });
});

// ---------------------------------------------------------------------------
// F3: focused steering carries reference context + audit; attachments defer
// ---------------------------------------------------------------------------

describe('focused steering input', () => {
    it('steers reference context with an audit record and never drops attachments', async () => {
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        const base = store.enqueue(created.id, 'base');
        await base.settled;

        fixture.gate('start');
        const running = store.enqueue(created.id, 'start', undefined, undefined, 'thread-1');
        await fixture.started('start').promise;

        const steered = store.enqueue(created.id, 'focused', undefined, [
            { turnId: base.turn.id, label: 'PE1' }
        ], 'thread-1');

        expect(steered.steered).toBe(true);
        expect(steered.steeredThreadId).toBe('thread-1');
        expect(steered.turn.id).toBe(running.turn.id);
        // Audit: the user's prompt and the bound block, no duplicated events.
        expect(steered.turn.steers).toEqual([
            {
                at: expect.any(Number),
                prompt: 'focused',
                references: [{ turnId: base.turn.id, label: 'PE1' }]
            }
        ]);
        await steered.settled;

        fixture.gate('start').resolve();
        await running.settled;
        await store.waitForIdle(created.id);

        // The steered text carried the delimited reference context.
        const requests = fixture.requests.map((messages) => lastUser(messages));
        expect(requests).toEqual([
            'base',
            'start',
            [
                'focused',
                '',
                REFERENCED_RESULTS_HEADER,
                `--- #PE1 | agent probe | turn ${base.turn.id} ---`,
                'answer:base',
                '--- end #PE1 ---',
                REFERENCED_RESULTS_FOOTER
            ].join('\n')
        ]);

        // An ATTACHMENT-bearing focused submit is not steered (the runtime's steer
        // API is text-only): it becomes a queued continuation that keeps its bytes.
        fixture.gate('long');
        const long = store.enqueue(created.id, 'long', undefined, undefined, 'thread-1');
        await fixture.started('long').promise;

        const attachment = {
            id: 'image-1',
            kind: 'image' as const,
            marker: '[Image 1]',
            name: 'pixel.png',
            mime: 'image/png',
            size: 8,
            data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
        };
        const deferred = store.enqueue(created.id, '', [attachment], undefined, 'thread-1');
        expect(deferred.steered).toBeUndefined();
        expect(deferred.turn.status).toBe('queued');
        expect(deferred.turn.attachments).toEqual([attachment]);
        expect(store.get(created.id).turns.at(-1)!.steers).toBeUndefined();

        fixture.gate('long').resolve();
        await long.settled;
        await deferred.settled;
        await store.waitForIdle(created.id);

        const mediaRequest = fixture.requests.at(-1)!;
        expect(lastUser(mediaRequest)).toBe('[Image 1]');
        const mediaMessage = mediaRequest.find((message) => message.role === 'user' && message.attachments !== undefined);
        expect(mediaMessage).toEqual({ role: 'user', content: '[Image 1]', attachments: [attachment] });
    });
});

// ---------------------------------------------------------------------------
// F4: deletion atomicity while a stopped run is still unwinding
// ---------------------------------------------------------------------------

describe('thread deletion atomicity', () => {
    // A transport that IGNORES the abort signal and only answers when the test
    // releases it: the run is logically stopped but the harness promise is live.
    const stubbornPreset = (): { preset: HarnessPreset; started: Deferred; release: Deferred } => {
        const started = deferred();
        const release = deferred();

        const preset = presetOf('stubborn', (settings, progress) =>
            harness({
                agents: {
                    stubborn: agent({
                        model: settings.model,
                        instruction: 'sys',
                        stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
                            started.resolve();
                            // Deliberately ignores request.signal.
                            await release.promise;
                            yield { type: 'text', delta: 'late' };
                            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                        }
                    })
                },
                primary: 'stubborn',
                presets: false,
                report: { progress }
            })
        );

        return { preset, started, release };
    };

    it('rejects a delete while the stopped run is unwinding, leaving disk and memory unchanged', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't4-threads-'));
        const fixture = stubbornPreset();
        const persistence = new HarnessPersistence(root);
        const store = createStore([fixture.preset], persistence);
        const created = store.create('stubborn');

        const task = store.enqueue(created.id, 'work');
        await fixture.started.promise;

        expect(store.cancelThread(created.id, 'thread-1').cancelled).toBe(true);
        // The run ignores the abort: the turn is still live.
        expect(store.get(created.id).turns[0].status).toBe('running');

        const diskBefore = fs.readFileSync(persistence.file, 'utf8');
        const memoryBefore = store.get(created.id);

        let refusal: unknown;
        try {
            store.deleteThread(created.id, 'thread-1');
        } catch (error) {
            refusal = error;
        }
        expect(refusal).toMatchObject({ status: 409 });
        expect((refusal as Error).message).toBe(
            'Thread "thread-1" still has live work; wait for it to stop before deleting it.'
        );

        // F4: no durable write and no in-memory mutation happened.
        expect(fs.readFileSync(persistence.file, 'utf8')).toBe(diskBefore);
        expect(store.get(created.id)).toEqual(memoryBefore);

        // Once the late answer settles (discarded by the runtime), deletion works.
        fixture.release.resolve();
        await task.settled;
        await store.waitForIdle(created.id);

        const deleted = store.deleteThread(created.id, 'thread-1');
        expect(deleted.turns).toEqual([]);
        expect(deleted.threads).toBeUndefined();

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
});

// ---------------------------------------------------------------------------
// F5/F6: thread-id high-water and agentResult purge across a restart
// ---------------------------------------------------------------------------

describe('thread deletion persistence', () => {
    it('never reuses a deleted thread id after a restart, even with no host threads left', () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't4-threads-'));
        const fixture = createFixture();
        const persistence = new HarnessPersistence(root);
        const first = createStore([fixture.preset], persistence);
        const created = first.create('probe');

        const task = first.enqueue(created.id, 'one');
        expect(task.turn.threadId).toBe('thread-1');
        return task.settled.then(async () => {
            await first.waitForIdle(created.id);
            expect(first.deleteThread(created.id, 'thread-1').threads).toBeUndefined();
            first.dispose();

            // F5: the id high-water survives an empty roster.
            const second = createStore([fixture.preset], persistence, persistence.load());
            const next = second.enqueue(created.id, 'two');
            expect(next.turn.threadId).toBe('thread-2');
            await next.settled;
            await second.waitForIdle(created.id);

            second.dispose();
            fs.rmSync(root, { recursive: true, force: true });
        });
    });
});

// ---------------------------------------------------------------------------
// F8: a runtime capacity refusal is an actionable 429, not a 500
// ---------------------------------------------------------------------------

describe('thread capacity errors', () => {
    it('maps the host-thread bound to an actionable 429 before mutating', () => {
        const fixture = createFixture();
        const capacity = 'This session already has 256 independent threads; delete a terminal one before creating another (maximum 256).';

        // A harness handle with the real thread API except the creation bound, which
        // the runtime enforces with a HarnessError (the server must translate it).
        const preset: HarnessPreset = {
            ...fixture.preset,
            create: (...args: Parameters<HarnessPreset['create']>) => {
                const inner = fixture.preset.create(...args);

                return new Proxy(inner, {
                    get(target, property, receiver) {
                        if (property === 'createThread') {
                            return () => {
                                throw new Error(capacity);
                            };
                        }

                        return Reflect.get(target, property, receiver);
                    }
                });
            }
        };

        const store = createStore([preset]);
        const created = store.create('probe');

        let failure: unknown;
        try {
            store.enqueue(created.id, 'overflow');
        } catch (error) {
            failure = error;
        }

        expect(failure).toMatchObject({ status: 429 });
        expect((failure as Error).message).toBe(`Could not open a new thread: ${capacity}`);

        // Nothing was accepted: no turn, no thread, no pending work.
        expect(store.get(created.id).turns).toEqual([]);
        expect(store.get(created.id).threads).toBeUndefined();
        expect(store.get(created.id).queueDepth).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// F7: a cascaded stop classifies the descendant LANE as cancelled
// ---------------------------------------------------------------------------

describe('cascaded thread stop', () => {
    it('cancels a descendant lane and leaves a sibling conversation running', async () => {
        const gates = new Map<string, ReturnType<typeof deferred>>();
        const starts = new Map<string, ReturnType<typeof deferred>>();

        const gateOf = (prompt: string): Deferred => {
            const created = gates.get(prompt) ?? deferred();
            gates.set(prompt, created);
            return created;
        };
        const startedOf = (prompt: string): Deferred => {
            const created = starts.get(prompt) ?? deferred();
            starts.set(prompt, created);
            return created;
        };
        let leadRequests = 0;

        const preset: HarnessPreset = {
            name: 'lead',
            title: 'lead',
            description: 'lead',
            requiresEndpoint: false,
            primary: 'lead',
            subagents: ['helper'],
            agents: ['lead', 'helper'],
            tools: [],
            builtin: true,
            editable: true,
            create: (settings, progress) =>
                harness({
                    agents: {
                        lead: agent({
                            model: settings.model,
                            instruction: 'lead',
                            stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                                startedOf(lastUser(request.messages)).resolve();
                                leadRequests += 1;

                                if (leadRequests === 1) {
                                    yield {
                                        type: 'done',
                                        stopReason: 'tool_calls',
                                        toolCalls: [
                                            {
                                                id: 'delegate-1',
                                                name: 'agentDelegate',
                                                arguments: JSON.stringify({
                                                    agent: 'helper',
                                                    input: 'child work'
                                                })
                                            }
                                        ]
                                    };
                                    return;
                                }

                                yield { type: 'text', delta: 'lead answer' };
                                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                            }
                        }),
                        helper: agent({
                            model: settings.model,
                            instruction: 'helper',
                            stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                                const prompt = lastUser(request.messages);
                                startedOf(prompt).resolve();

                                if (prompt === 'child hold') {
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
                                        gateOf(prompt).promise.then(resolve, reject);
                                    });
                                }

                                yield { type: 'text', delta: `answer:${prompt}` };
                                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                            }
                        })
                    },
                    primary: 'lead',
                    subagents: ['helper'],
                    presets: false,
                    report: { progress }
                })
        };

        const store = createStore([preset]);
        const created = store.create('lead');

        // The runtime opens the child conversation for the delegation.
        const task = store.enqueue(created.id, 'delegate please');
        await task.settled;
        await store.waitForIdle(created.id);
        expect(store.get(created.id).threads!.find((thread) => thread.id === 'thread-2')!.ownerThreadId).toBe(
            'thread-1'
        );

        // Server turns in the parent and the (owner-linked) child conversation, plus
        // an unrelated sibling: only the parent's lineage is stopped.
        gateOf('parent hold');
        gateOf('child hold');
        gateOf('sibling');
        const parent = store.enqueue(created.id, 'parent hold', undefined, undefined, 'thread-1');
        await startedOf('parent hold').promise;
        const child = store.enqueue(created.id, 'child hold', undefined, undefined, 'thread-2');
        await startedOf('child hold').promise;
        const sibling = store.enqueue(created.id, 'sibling');
        await startedOf('sibling').promise;

        expect(store.cancelThread(created.id, 'thread-1').cancelled).toBe(true);

        gateOf('parent hold').resolve();
        gateOf('child hold').resolve();
        gateOf('sibling').resolve();
        await parent.settled;
        await child.settled;
        await sibling.settled;
        await store.waitForIdle(created.id);

        const final = store.get(created.id);
        const statusOf = (turnId: string): string =>
            final.turns.find((turn) => turn.id === turnId)!.status;

        expect(statusOf(parent.turn.id)).toBe('cancelled');
        // F7: the cascaded child lane is CANCELLED, not misreported as an error.
        expect(statusOf(child.turn.id)).toBe('cancelled');
        // The sibling conversation is untouched.
        expect(statusOf(sibling.turn.id)).toBe('done');
    });
});

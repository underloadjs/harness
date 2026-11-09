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
import { HARNESS_DATABASE_VERSION, HarnessPersistence, readHarnessDatabase } from './persistence';
import { SessionError, SessionStore } from './sessions';
import type {
    CancelSessionResult,
    CancelThreadResult,
    DeleteThreadResult,
    TaskReceipt,
    ThreadSummary,
    ThreadSummaryPage,
    TurnResource,
    TurnResponse,
    TurnSummary,
    TurnSummaryPage
} from '../shared/harness-api';
import type { SessionSnapshot, SessionThread, SessionView } from './protocol';
import { listAgentResultBlocks, REFERENCED_RESULTS_FOOTER, REFERENCED_RESULTS_HEADER } from '../shared/agent-results';

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

// REV2 (R1) FIXTURE: a transport whose runs FAIL until the test says the provider is healthy
// again. The state the request is about — a row that ended `error` on a conversation the host
// never stopped — is therefore something the store PRODUCED, not a record a test hand-edited,
// and the resumed row reaching `done` proves the replay really executed instead of re-labelling
// the old one. The core retries a failed request inside ONE run, hence the switch rather than an
// attempt counter.
const flakyFixture = (): { preset: HarnessPreset; heal: () => void } => {
    let failing = true;

    return {
        preset: presetOf('probe', (settings, progress) =>
            harness({
                agents: {
                    probe: agent({
                        model: settings.model,
                        instruction: 'sys',
                        // ONE attempt: the core's default retry policy (one initial request plus
                        // ten doubling waits, ./core/agent.ts:292) would spend twenty seconds
                        // retrying the deliberate failure, and those retries would themselves
                        // produce the `error` row this fixture is about — which is not what the
                        // test is naming.
                        retry: { maxRetries: 0 },
                        stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
                            if (failing) throw new Error('provider exploded');

                            yield { type: 'text', delta: 'answer:question' };
                            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                        }
                    })
                },
                primary: 'probe',
                presets: false,
                // The store's recorder rides the harness's own progress report; a preset that
                // omits it runs without the turn ever recording its frames.
                report: { progress }
            })
        ),
        heal: () => {
            failing = false;
        }
    };
};

// The restore's recovery sentence, verbatim (./sessions.ts:764, module-private there). The
// banner the reported screenshot paints IS this string on the session record, so the resume
// tests below pin against the literal rather than against a paraphrase — the same convention
// ./background.test.ts:117 and ./shutdown-background.test.ts:77 use.
const RESTART_BANNER =
    'The previous run was interrupted by a server restart; it was not replayed. Review the recorded events before continuing.';

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
        const created = await store.create('probe');

        const task = await store.enqueue(created.id, '  hello  ');
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
        expect(withoutIds(snapshot.threads)).toEqual([
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
                // R3: the thread's full invocation roster (oldest first), so a client
                // can still join a HISTORICAL invocation card after the conversation
                // advances. Derived from the persisted `invocationThreads` map.
                invocationIds: ['1'],
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
        const created = await store.create('probe');

        const first = await store.enqueue(created.id, 'one');
        await first.settled;
        const second = await store.enqueue(created.id, 'two');
        await second.settled;
        const third = await store.enqueue(created.id, 'three');
        await third.settled;

        // Three DISTINCT conversations: PE1, PE2, PE3 (not T1/T2/T3 and not one
        // number per invocation).
        expect(store.get(created.id).threads?.map((thread) => thread.label)).toEqual([
            'PE1',
            'PE2',
            'PE3'
        ]);

        // A continuation of PE2 repeats its label and consumes NO new ordinal.
        const continuation = await store.enqueue(created.id, 'again', undefined, undefined, second.turn.threadId);
        expect(continuation.turn.threadId).toBe(second.turn.threadId);
        expect(continuation.turn.threadLabel).toBe('PE2');
        await continuation.settled;
        expect(store.get(created.id).threads?.map((thread) => thread.label)).toEqual([
            'PE1',
            'PE2',
            'PE3'
        ]);

        // Deleting PE1 retires its name: the next standalone conversation is PE4.
        await store.deleteThread(created.id, first.turn.threadId as string);
        const fourth = await store.enqueue(created.id, 'four');
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
        const created = await store.create('probe');

        const first = await store.enqueue(created.id, 'one');
        await first.settled;

        const second = await store.enqueue(created.id, 'two', undefined, undefined, 'thread-1');
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
        const created = await store.create('probe');

        // Two standalone threads (each unfocused submit is serialized and completes).
        const seedOne = await store.enqueue(created.id, 'seed-one');
        await seedOne.settled;
        const seedTwo = await store.enqueue(created.id, 'seed-two');
        await seedTwo.settled;

        fixture.gate('left');
        fixture.gate('right');

        const left = await store.enqueue(created.id, 'left', undefined, undefined, 'thread-1');
        await fixture.started('left').promise;
        const right = await store.enqueue(created.id, 'right', undefined, undefined, 'thread-2');
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
        const created = await store.create('probe');

        fixture.gate('start');
        const running = await store.enqueue(created.id, 'start');
        await fixture.started('start').promise;

        const steered = await store.enqueue(created.id, 'more', undefined, undefined, 'thread-1');
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

    it('gives two submits recorded in one millisecond one bar segment each, and its own bytes', async () => {
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        fixture.gate('start');
        const running = await store.enqueue(created.id, 'start');
        await fixture.started('start').promise;

        // Two guidance submits the AUDIT RECORD cannot tell apart: the store stamps each
        // one with `Date.now()`, and both texts are 4 characters. Mocking the clock is what
        // makes that collision reproducible instead of a race.
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        const first = await store.enqueue(created.id, 'aaaa', undefined, undefined, 'thread-1');
        const second = await store.enqueue(created.id, 'bbbb', undefined, undefined, 'thread-1');
        clock.mockRestore();

        expect(first.steered).toBe(true);
        expect(second.steered).toBe(true);
        await first.settled;
        await second.settled;

        fixture.gate('start').resolve();
        await running.settled;
        await store.waitForIdle(created.id);

        const turnId = store.get(created.id).turns[0].id;
        const records = store.get(created.id).turns[0].steers ?? [];
        const view = store.getView(created.id);
        const steered = (view.displays[turnId].sections[0].context ?? []).filter((block) => block.name === 'steer');

        // T13: the record now carries the identity the segment keys off. These two submits are
        // indistinguishable by `(at, length)` — the mock proves it — so ONLY a per-submit id
        // can keep them apart, and the id must be minted once (never re-derived).
        expect(records).toHaveLength(2);
        expect(records[0].id).toEqual(expect.any(String));
        expect(records[1].id).toEqual(expect.any(String));
        expect(records[0].id).not.toBe(records[1].id);
        expect([records[0].at, records[0].prompt.length]).toEqual([records[1].at, records[1].prompt.length]);

        const firstKey = `0-user-i${records[0].id}`;
        const secondKey = `0-user-i${records[1].id}`;

        // R6: every recorded submit is its own segment, counted exactly once. One merged
        // segment here would silently drop a submit from the bar and from its totals.
        expect(steered.map((block) => [block.id, block.chars])).toEqual([
            [firstKey, 4],
            [secondKey, 4]
        ]);

        // R8: and each segment answers with ITS OWN recorded text, not the first match.
        expect(store.blockDetail(created.id, turnId, firstKey).text).toBe('aaaa');
        expect(store.blockDetail(created.id, turnId, secondKey).text).toBe('bbbb');

        // The row carries the same identity, so a client can address a submit without
        // re-deriving anything from a timestamp.
        expect(view.turns[0].steers?.map((steer) => [steer.id, steer.prompt])).toEqual([
            [records[0].id, 'aaaa'],
            [records[1].id, 'bbbb']
        ]);
    });

    // T13/T14/T15 regression: 520 indistinguishable submits (one mocked millisecond, all the
    // same length) overflow the 64-entry AUDIT ring on purpose — and pass far beyond any
    // smaller archive bound. The ring keeps its bounded semantics, but EVERY submit the server
    // accepted is archived durably by its own id and never discarded, so the FIRST segment
    // (trimmed from the ring at submit 65) and the LAST one are both drawn and resolvable
    // while the run is active, after it completes, and after a restart.
    it('keeps every submit distinct across the steer audit ring and a restart', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't15-steer-archive-'));
        const fixture = createFixture();
        const persistence = new HarnessPersistence(root);
        const store = createStore([fixture.preset], persistence);
        const created = await store.create('probe');

        fixture.gate('start');
        const running = await store.enqueue(created.id, 'start');
        await fixture.started('start').promise;

        // 520 prompts, all 5 characters, all recorded in the same mocked millisecond: the
        // audit record cannot tell any two of them apart on `(at, length)`. Mocking the clock
        // is what makes that reproducible instead of a race.
        const SUBMITS = 520;
        const RING = 64;
        const prompts = Array.from({ length: SUBMITS }, (_entry, index) => `s${String(index).padStart(4, '0')}`);
        const trimmed = prompts.slice(0, SUBMITS - RING);
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        // D4: every submit must be DISPATCHED in one synchronous batch - that is what makes them
        // steer into the conversation the run owns instead of queueing behind it - so the map
        // callback stays non-async and the now-async durability is collected with `Promise.all`
        // AFTER the clock is restored. Same interleaving and the same frozen `at` values; each
        // accepted submit is now durable before its receipt is inspected.
        const pending = prompts.map(async (prompt) => await store.enqueue(created.id, prompt, undefined, undefined, 'thread-1'));

        clock.mockRestore();

        const receipts = await Promise.all(pending);

        expect(receipts.every((receipt) => receipt.steered === true)).toBe(true);
        await Promise.all(receipts.map((receipt) => receipt.settled));

        const turnId = store.get(created.id).turns[0].id;
        const recordsOf = () => {
            const turn = store.get(created.id).turns[0];

            return { ring: turn.steers ?? [], archive: turn.steerTexts ?? [] };
        };
        const segmentIds = (view: ReturnType<SessionStore['getView']>) =>
            (view.displays[turnId].sections[0].context ?? []).filter((block) => block.name === 'steer');
        // A ring-trimmed prompt must never reach the compact wire. Checked as one pass over
        // the serialised view (520 substrings would otherwise each rescan a large document).
        const wirePrompts = (view: ReturnType<SessionStore['getView']>, expected: readonly string[]): string[] => {
            const wire = JSON.stringify(view);

            return expected.filter((prompt) => wire.includes(prompt));
        };

        // The bounded audit ring kept the LAST 64, in acceptance order (its contract, and the
        // compact row's), while the durable archive kept ALL 520 with their exact text: an
        // accepted submit is user data, so nothing is truncated away (T15).
        const { ring, archive } = recordsOf();

        expect(ring).toHaveLength(RING);
        expect(ring.map((steer) => steer.prompt)).toEqual(prompts.slice(SUBMITS - RING));
        expect(archive).toHaveLength(SUBMITS);
        expect(archive.map((entry) => entry.prompt)).toEqual(prompts);
        expect(new Set(archive.map((entry) => entry.id)).size).toBe(SUBMITS);
        // The archive is addressed by the ring's OWN ids: an archived entry and the audit
        // record it came from are the same submit, one identity.
        expect(ring.map((steer) => steer.id)).toEqual(archive.slice(SUBMITS - RING).map((entry) => entry.id));

        // The two ends of the list, held by id: the FIRST submit is the oldest one the ring
        // threw away, the LAST is the newest. Both must survive every phase below.
        const firstSubmit = archive[0];
        const lastSubmit = archive[SUBMITS - 1];
        const firstKey = `0-user-i${firstSubmit.id}`;
        const lastKey = `0-user-i${lastSubmit.id}`;

        // WHILE THE RUN IS ACTIVE: the bar drew every accepted submit — the 456 the ring has
        // already dropped included — and each end answers with its own text.
        const liveView = store.getView(created.id);
        const liveSegments = segmentIds(liveView);

        expect(liveSegments).toHaveLength(SUBMITS);
        expect(liveSegments.map((block) => block.id)).toEqual(archive.map((entry) => `0-user-i${entry.id}`));

        const liveEnds = (key: string, prompt: string): void => {
            const [segment] = liveSegments.filter((block) => block.id === key);

            expect(segment).toEqual({
                kind: 'user',
                id: key,
                turnId,
                sectionId: `${turnId}:0`,
                name: 'steer',
                at: 1_700_000_000_000,
                chars: 5,
                inPrompt: true
            });
            expect(store.blockDetail(created.id, turnId, key)).toEqual({
                ...segment,
                sessionId: created.id,
                text: prompt
            });
        };

        liveEnds(firstKey, prompts[0]);
        liveEnds(lastKey, prompts[SUBMITS - 1]);

        // A ring-trimmed submit is NOT on the compact wire: the row publishes the bounded audit
        // ring, and the archived text is only ever answered by the lazy block route. (No
        // trimmed prompt can hide inside a uuid either — every prompt starts with `s`, which is
        // not a hex digit.)
        expect(wirePrompts(liveView, trimmed)).toEqual([]);
        expect(liveView.turns[0].steers).toHaveLength(RING);

        fixture.gate('start').resolve();
        await running.settled;
        await store.waitForIdle(created.id);

        const view = store.getView(created.id);
        const segments = segmentIds(view);

        // The completed bar is unchanged by the ring: 520 id-keyed segments, one per accepted
        // submit, each counting its own 5 characters.
        expect(segments).toHaveLength(SUBMITS);
        expect(segments.map((block) => block.id)).toEqual(archive.map((entry) => `0-user-i${entry.id}`));
        expect(segments.every((block) => block.chars === 5 && block.inPrompt === true)).toBe(true);
        expect(recordsOf().ring).toHaveLength(RING);

        // EVERY visible segment resolves its own recorded text — the R8 rule the ring used to
        // break at submit 65 and an archive bound would have broken at 521.
        expect(segments.map((block) => store.blockDetail(created.id, turnId, block.id).text)).toEqual(prompts);
        expect(store.blockDetail(created.id, turnId, firstKey).text).toBe(prompts[0]);
        expect(store.blockDetail(created.id, turnId, lastKey).text).toBe(prompts[SUBMITS - 1]);
        expect(JSON.stringify(view.turns[0])).toContain(prompts[SUBMITS - RING]);
        expect(wirePrompts(view, trimmed)).toEqual([]);

        // AND THE SAME ANSWERS COME BACK FROM A FRESH STORE OVER THE SAME ROOT: the ids and
        // the archived bytes are durable, the re-projected bar reproduces the archived
        // segments (not merely the last 64), and a segment captured before the restart still
        // resolves after it.
        const written = persistence.load();

        if (written === undefined) throw new Error('the steer checkpoint did not persist');

        // The whole archive is IN THE DOCUMENT (not only in memory), and it cost no schema
        // bump — `HARNESS_DATABASE_VERSION` is still 1, so an older server reads this file too.
        expect(written.version).toBe(HARNESS_DATABASE_VERSION);
        expect(written.sessions[0].turns[0].steerTexts?.map((entry) => entry.prompt)).toEqual(prompts);
        expect(written.sessions[0].turns[0].steers?.map((steer) => steer.prompt)).toEqual(
            prompts.slice(SUBMITS - RING)
        );

        const reloaded = createStore([fixture.preset], persistence, persistence.load());

        expect(reloaded.get(created.id).turns[0].steers ?? []).toHaveLength(RING);
        expect(reloaded.get(created.id).turns[0].steerTexts ?? []).toHaveLength(SUBMITS);

        const reloadedView = reloaded.getView(created.id);
        const reloadedSegments = segmentIds(reloadedView);

        expect(reloadedSegments.map((block) => block.id)).toEqual(segments.map((block) => block.id));
        expect(reloadedSegments.map((block) => [block.id, block.chars])).toEqual(
            segments.map((block) => [block.id, block.chars])
        );
        expect(reloadedSegments.map((block) => reloaded.blockDetail(created.id, turnId, block.id).text)).toEqual(
            prompts
        );
        expect(reloaded.blockDetail(created.id, turnId, firstKey).text).toBe(prompts[0]);
        expect(reloaded.blockDetail(created.id, turnId, lastKey).text).toBe(prompts[SUBMITS - 1]);

        // LEGACY COMPATIBILITY: a document written before the archive existed carries only
        // the bounded audit ring. Rewriting the checkpoint that way (the shape an older
        // build leaves behind) must still load, still draw a bar whose every segment
        // resolves, and answer the dropped submits with an honest 404 — never a successful
        // detail with no text in it.
        reloaded.dispose();

        // Rewrite the checkpoint the way a build BEFORE the archive wrote it.
        delete written.sessions[0].turns[0].steerTexts;
        persistence.save(written);

        const legacy = createStore([fixture.preset], persistence, persistence.load());

        expect(legacy.get(created.id).turns[0].steerTexts).toBeUndefined();

        const legacySegments = segmentIds(legacy.getView(created.id));

        // The legacy bar draws the 64 submits the ring still names, and each one answers.
        expect(legacySegments.map((block) => block.id)).toEqual(
            recordsOf().ring.map((steer) => `0-user-i${steer.id}`)
        );
        expect(legacySegments.map((block) => legacy.blockDetail(created.id, turnId, block.id).text)).toEqual(
            prompts.slice(SUBMITS - RING)
        );
        // The first submit is not drawn at all, and a client still holding its segment id
        // gets a 404 instead of an empty panel.
        expect(legacySegments.some((block) => block.id === firstKey)).toBe(false);
        expect(() => legacy.blockDetail(created.id, turnId, firstKey)).toThrow(/Unknown context block/);
        // A turn that carries no steer at all keeps its existing 404 wording.
        expect(() => legacy.blockDetail(created.id, 'no-such-turn', firstKey)).toThrow(/Unknown turn/);

        // CLEANUP: the archive rides the TURN record, so removing the conversation that owns
        // the steered run takes the archived bytes with it — no orphaned steer text is left in
        // the document behind a deleted conversation (reset and session removal work the same
        // way, because they drop the same turn records).
        const deleted = await store.deleteThread(created.id, threadOf(store.get(created.id), turnId));

        expect(deleted.turns).toHaveLength(0);
        expect(persistence.load()?.sessions[0].turns.some((turn) => turn.steerTexts !== undefined)).toBe(false);

        store.dispose();
        legacy.dispose();
        fs.rmSync(root, { recursive: true, force: true });
        // D4: this case performs 520 ACCEPTED submits, and every accepted submit is now durable
        // before its receipt (`await persistOrThrow`), so the test does 520 awaited
        // whole-document commits on a growing record. Alone it lands near the suite's global
        // 15 s budget and under full-suite load it crosses it, so the budget is raised HERE
        // rather than by loosening `testTimeout` for every spec. No assertion was changed or
        // removed - the work simply takes longer than 15 s when the whole suite runs at once.
    }, 60_000);

    it('rejects a blank or unknown thread id and steers/continues only real threads', async () => {
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        await expect(store.enqueue(created.id, 'x', undefined, undefined, '   ')).rejects.toThrow(
            '`threadId` must be a non-empty string when present.'
        );
        await expect(store.enqueue(created.id, 'x', undefined, undefined, 7)).rejects.toThrow(
            '`threadId` must be a non-empty string when present.'
        );

        // The thread must EXIST before it can be addressed.
        const seed = await store.enqueue(created.id, 'seed');
        await seed.settled;

        const task = await store.enqueue(created.id, 'known', undefined, undefined, 'thread-1');
        expect(task.turn.threadId).toBe('thread-1');
        await task.settled;

        await expect(store.enqueue(created.id, 'x', undefined, undefined, 'thread-404')).rejects.toThrow(
            'Unknown thread "thread-404".'
        );
    });

    it('stops one thread (running and queued work) and leaves the legacy run alone', async () => {
        pinClock(3_000);
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        const seed = await store.enqueue(created.id, 'seed');
        await seed.settled;

        // Hold the exclusive gate with a legacy run, so the lane submit QUEUES.
        fixture.gate('legacy');
        const legacy = store.run(created.id, 'legacy', async () => {});
        await fixture.started('legacy').promise;

        const queued = await store.enqueue(created.id, 'waiting', undefined, undefined, 'thread-1');
        expect(queued.turn.status).toBe('queued');

        const stopped = await store.cancelThread(created.id, 'thread-1');
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
        const created = await store.create('probe');

        fixture.gate('long');
        const running = await store.enqueue(created.id, 'long');
        await fixture.started('long').promise;

        const stopped = await store.cancelThread(created.id, 'thread-1', 'owner stopped it');
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

        await expect(store.cancelThread(created.id, 'thread-404')).rejects.toThrow('Unknown thread "thread-404".');
        await expect(store.cancelThread('missing', 'thread-1')).rejects.toThrow('Unknown session "missing".');
    });

    it('stops every host thread and backlog on cancel { all: true }', async () => {
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        // F1: two plain submits run CONCURRENTLY in their own lanes; stop-all must
        // stop both conversations and abort both runs.
        fixture.gate('active');
        fixture.gate('sibling');
        const active = await store.enqueue(created.id, 'active');
        await fixture.started('active').promise;
        const sibling = await store.enqueue(created.id, 'sibling');
        await fixture.started('sibling').promise;
        expect(fixture.peak()).toBe(2);

        expect(await store.cancel(created.id, { all: true })).toBe(true);

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
        const created = await store.create('probe');

        const seed = await store.enqueue(created.id, 'seed');
        await seed.settled;

        // Hold a LANE run in thread-1 so its record is live.
        fixture.gate('hold');
        const held = await store.enqueue(created.id, 'hold', undefined, undefined, 'thread-1');
        await fixture.started('hold').promise;

        await expect(store.deleteThread(created.id, 'thread-1')).rejects.toThrow(SessionError);
        await expect(store.deleteThread(created.id, 'thread-1')).rejects.toThrow(
            'Thread "thread-1" still has live work; wait for it to stop before deleting it.'
        );
        await expect(store.deleteThread(created.id, 'thread-404')).rejects.toThrow(
            'Unknown thread "thread-404".'
        );
        await expect(store.deleteThread(created.id, 'agent:probe')).rejects.toThrow(
            'Thread "agent:probe" is the agent\'s own conversation and cannot be deleted; use reset to clear the session.'
        );

        await store.cancel(created.id, { all: true });
        fixture.gate('hold').resolve();
        await held.settled;
        await store.waitForIdle(created.id);

        // A stopped, idle thread deletes cleanly and its turns/transcript go with it.
        const deleted = await store.deleteThread(created.id, 'thread-1');
        expect(deleted.threads).toBeUndefined();
        expect(deleted.turns).toEqual([]);
    });

    it('keeps indices monotonic and surviving labels stable across a deletion', async () => {
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        const one = await store.enqueue(created.id, 'one');
        await one.settled;
        const two = await store.enqueue(created.id, 'two');
        await two.settled;
        const three = await store.enqueue(created.id, 'three');
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

        await store.deleteThread(created.id, threadOf(before, one.turn.id));

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
        const reuse = await store.enqueue(created.id, 'reuse #PE2');
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
        await expect(store.enqueue(created.id, 'gone', undefined, [{ turnId: one.turn.id, label: 'PE1' }])).rejects.toThrow(`Referenced turn "${one.turn.id}" does not exist in this session.`);

        // The index high-water mark never reuses a deleted turn's index.
        const next = await store.enqueue(created.id, 'next');
        expect(next.turn.index).toBe(4);
        await next.settled;
    });

    it('removes the deleted thread and its turns from the persisted document', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't4-threads-'));
        const fixture = createFixture();
        const persistence = new HarnessPersistence(root);
        const store = createStore([fixture.preset], persistence);
        const created = await store.create('probe');

        const one = await store.enqueue(created.id, 'one');
        await one.settled;
        const two = await store.enqueue(created.id, 'two');
        await two.settled;
        await store.waitForIdle(created.id);

        const deleted = await store.deleteThread(created.id, threadOf(store.get(created.id), one.turn.id));
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
        const created = await first.create('probe');

        const done = await first.enqueue(created.id, 'kept');
        await done.settled;

        // Hold a LEGACY run so a lane submit stays queued at "crash" time.
        fixture.gate('legacy');
        void first.run(created.id, 'legacy', async () => {});
        await fixture.started('legacy').promise;
        const queued = await first.enqueue(created.id, 'pending-lane', undefined, undefined, 'thread-1');
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
        expect(withoutIds(restored.threads)).toEqual([
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
                // R3: the historical invocation roster survives the restart, because it
                // is derived from the persisted `invocationThreads` map.
                invocationIds: ['1'],
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
        const kick = await second.enqueue(created.id, 'after restart', undefined, undefined, 'thread-1');
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

    it('reads a pre-thread document (no thread fields) without failing', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't4-threads-'));
        const fixture = createFixture();
        const persistence = new HarnessPersistence(root);
        const store = createStore([fixture.preset], persistence);
        const created = await store.create('probe');
        const task = await store.enqueue(created.id, 'one');
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

    // Canonical reads used by the migrated HTTP-contract assertions below. The submit
    // answer is a slim receipt (T17), so every "what did the server actually record"
    // question is answered by an explicit paged/identified read instead of a fat body.
    const turnOf = async (runtime: HarnessRuntime, sessionId: string, turnId: string): Promise<TurnResource> => {
        const result = await jsonOf<TurnResponse>(
            await callApi(runtime, 'GET', `/v1/harness/sessions/${sessionId}/turns/${turnId}`)
        );

        expect(result.status).toBe(200);
        return result.body.turn;
    };

    const threadRosterOf = async (runtime: HarnessRuntime, sessionId: string): Promise<ThreadSummary[]> => {
        const result = await jsonOf<ThreadSummaryPage>(
            await callApi(runtime, 'GET', `/v1/harness/sessions/${sessionId}/threads`)
        );

        expect(result.status).toBe(200);
        return result.body.items;
    };

    const turnRowsOf = async (runtime: HarnessRuntime, sessionId: string): Promise<TurnSummary[]> => {
        const result = await jsonOf<TurnSummaryPage>(
            await callApi(runtime, 'GET', `/v1/harness/sessions/${sessionId}/turns`)
        );

        expect(result.status).toBe(200);
        return result.body.items;
    };

    it('accepts thread_id on /tasks, reports steering, and serves cancel/delete routes', async () => {
        const fixture = createFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'probe');

        // Unfocused submit: 202 receipt naming the thread the task opened.
        const accepted = await jsonOf<TaskReceipt>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, { input: 'first' })
        );
        expect(accepted.status).toBe(202);
        expect(accepted.body.thread_id).toBe('thread-1');
        expect(accepted.body.session_id).toBe(id);
        expect(accepted.body.links.turn).toBe(`/v1/harness/sessions/${id}/turns/${accepted.body.turn_id}`);
        await runtime.store.waitForIdle(id);

        // The durable record of that task carries the same thread routing.
        expect(await turnOf(runtime, id, accepted.body.turn_id)).toMatchObject({
            id: accepted.body.turn_id,
            index: 0,
            thread_id: 'thread-1',
            status: 'done'
        });

        // Continuation through the SAME thread keeps the envelope (no `steered`).
        const continued = await jsonOf<TaskReceipt>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
                input: 'second',
                thread_id: 'thread-1'
            })
        );
        expect(continued.status).toBe(202);
        expect(continued.body.thread_id).toBe('thread-1');
        expect(continued.body.steered).toBeUndefined();
        await runtime.store.waitForIdle(id);

        expect(await turnOf(runtime, id, continued.body.turn_id)).toMatchObject({
            index: 1,
            thread_id: 'thread-1'
        });

        // Steering a RUNNING thread: `steered: true` and the owning turn.
        fixture.gate('third');
        const running = await jsonOf<TaskReceipt>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
                input: 'third',
                thread_id: 'thread-1'
            })
        );
        await fixture.started('third').promise;

        const steered = await jsonOf<TaskReceipt>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
                input: 'steered text',
                thread_id: 'thread-1'
            })
        );
        expect(steered.status).toBe(202);
        expect(steered.body.steered).toBe(true);
        expect(steered.body.steered_thread_id).toBe('thread-1');
        expect(steered.body.turn_id).toBe(running.body.turn_id);

        // Unknown thread id over HTTP is a 404.
        const unknown = await jsonOf<{ error: { message: string } }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
                input: 'x',
                thread_id: 'thread-404'
            })
        );
        expect(unknown).toEqual({ status: 404, body: { error: { message: 'Unknown thread "thread-404".' } } });

        // Stop ONE thread: the canonical receipt states the thread and its new status,
        // and the roster read is the authoritative proof the stop landed.
        const cancelled = await jsonOf<CancelThreadResult>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/threads/thread-1/cancel`)
        );
        expect(cancelled.status).toBe(200);
        expect(cancelled.body).toMatchObject({
            cancelled: true,
            thread_id: 'thread-1',
            session_id: id,
            status: 'stopped'
        });
        expect(
            (await threadRosterOf(runtime, id)).find((row) => row.id === 'thread-1')!.status
        ).toBe('stopped');

        fixture.gate('third').resolve();
        await runtime.store.waitForIdle(id);

        // A stopped thread deletes; the cascade is reported by the receipt, and the
        // roster/turn pages prove the removal.
        const deleted = await jsonOf<DeleteThreadResult>(
            await callApi(runtime, 'DELETE', `/v1/harness/sessions/${id}/threads/thread-1`)
        );
        expect(deleted.status).toBe(200);
        expect(deleted.body).toMatchObject({
            deleted: true,
            thread_id: 'thread-1',
            session_id: id
        });
        expect((await threadRosterOf(runtime, id)).map((row) => row.id)).not.toContain('thread-1');
        expect((await turnRowsOf(runtime, id)).map((row) => row.threadId)).not.toContain('thread-1');

        const missing = await jsonOf<{ error: { message: string } }>(
            await callApi(runtime, 'DELETE', `/v1/harness/sessions/${id}/threads/thread-1`)
        );
        expect(missing).toEqual({
            status: 404,
            // The canonical 404 scopes the miss to the session in the path.
            body: { error: { message: `Unknown thread "thread-1" in session "${id}".` } }
        });
    });

    it('keeps /cancel { all: true } and reports the canonical cancel receipt', async () => {
        const fixture = createFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'probe');

        fixture.gate('active');
        void callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, { input: 'active' });
        await fixture.started('active').promise;

        const all = await jsonOf<CancelSessionResult>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/cancel`, { all: true })
        );

        // No legacy `{cancelled}`-only envelope: the receipt names the session, the run it
        // stopped, the queued tasks it dropped, and the revision the caller compares next.
        expect(all.status).toBe(200);
        expect(Object.keys(all.body).sort()).toEqual(
            ['active_turn_id', 'cancelled', 'dropped_queued_tasks', 'revision', 'session_id'].sort()
        );
        expect(all.body.cancelled).toBe(true);
        expect(all.body.session_id).toBe(id);
        expect(all.body.dropped_queued_tasks).toBe(0);

        fixture.gate('active').resolve();
        await runtime.store.waitForIdle(id);
    });
});


// ---------------------------------------------------------------------------
// R1 (REVISED, rev2): resuming an INTERRUPTED conversation re-runs its turn IN PLACE
// (store `resumeThread` + POST /sessions/:id/threads/:threadId/resume)
// ---------------------------------------------------------------------------
//
// A stop marks the run it aborted (and any backlog it dropped) `cancelled`, so the answer
// the user asked for never arrived. `resumeThread` puts THAT row back the way a submit
// minted it — same id, same index, status `queued`, its events rolled back to the last
// committed step — and hands it to the same lane, so the transcript keeps the two rows the
// user acted on instead of growing a third one that repeats the same question. REV2 widens
// the SAME mechanism to the two halts a stop never touched: a run that FAILED on the provider
// (its row is `error`, its conversation is back to `idle`) and the run a SERVER RESTART cut
// short (the restore marks that row `error` AND writes the restart sentence on the SESSION,
// which is the banner the user was looking at). Pinned here for all three:
// here: the requeued row's identity and shape (the anti-duplicate proof), the ledger
// before and after, the fidelity of prompt/attachments/references, the rollback boundary
// (the committed step survives, the abandoned attempt's chatter and its `usage` do not),
// the revived conversation status, every state guard (409 not stopped / answer reached /
// nothing recorded / work in flight / claim), the command-shaped fallback that still mints
// its own row, the durable restart paths (a replay from the record, and a crash
// mid-resume that restores ONLY the resumed attempt), and the HTTP route's receipt.
//
// The scripted fixture dispatches its gate on the conversation's FIRST user message
// (`routed`), so an anchor turn creates a conversation whose LATER runs can all be parked on
// one gate — that is how these tests hold a resumed run mid-flight and read `running`
// deterministically.

describe('interrupted-turn resume (a stopped OR idle conversation)', () => {
    // The one figure every test below is about: the compiled row for the resumed turn.
    // `detail` is the settled status line (the stop's own error text, then the model that
    // answered), so reading it with the status/state is what proves the projector cache was
    // dropped and the truncated record was re-folded.
    const rowOf = (store: SessionStore, id: string, index: number) => {
        const row = store.getView(id).turns.find((summary) => summary.index === index)!;

        return { index: row.index, status: row.status, state: row.state, detail: row.detail };
    };

    it('re-runs the interrupted row in place and revives the conversation', async () => {
        pinClock(1_000);
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        // A completed first turn: it makes the conversation's later runs park on the
        // `anchor` gate, which is what lets this test observe the resumed run mid-flight.
        const anchor = await store.enqueue(created.id, 'anchor');
        await anchor.settled;

        fixture.gate('anchor');
        const interrupted = await store.enqueue(created.id, 'question', undefined, undefined, 'thread-1');
        await fixture.started('question').promise;

        expect((await store.cancelThread(created.id, 'thread-1')).cancelled).toBe(true);
        await interrupted.settled;
        await store.waitForIdle(created.id);

        // THE STATE RESUME STARTS FROM: two rows, the conversation stopped, and no answer
        // for `question` anywhere. The stop wrote its own record INSIDE the row — the run's
        // frames plus the stop's error — and the compiled row shows that text.
        expect(store.get(created.id).turns.map((turn) => `${turn.index}:${turn.prompt}:${turn.status}`)).toEqual([
            '0:anchor:done',
            '1:question:cancelled'
        ]);
        expect(store.get(created.id).threads!.map((thread) => `${thread.id}:${thread.status}`)).toEqual([
            'thread-1:stopped'
        ]);
        expect(store.get(created.id).turns[1]!.events.map((event) => event.type)).toEqual(['start', 'error']);
        expect(rowOf(store, created.id, 1)).toEqual({
            index: 1,
            status: 'cancelled',
            state: 'cancelled',
            detail: 'Thread "thread-1" was stopped.'
        });

        const resumed = await store.resumeThread(created.id, 'thread-1');

        // THE RESUMED ROW IS THE INTERRUPTED ROW: same id, same index, `queued` (the accepted
        // record is captured before the pump runs it), and an EMPTY event list — the run never
        // reached a committed step, so nothing of the aborted attempt is kept. This is the
        // revision's whole point: the ledger does not grow, and the question is not asked twice.
        expect(resumed.turn).toEqual({
            id: interrupted.turn.id,
            index: 1,
            prompt: 'question',
            threadId: 'thread-1',
            threadLabel: 'PE1',
            status: 'queued',
            updatedAt: 1_000,
            events: [],
            eventTimes: []
        });

        // TWO rows while it runs. The lane pump takes the requeued row synchronously (it is
        // the same tick that stamps `startedAt`), so the live ledger already reads `running`.
        expect(store.get(created.id).turns.map((turn) => `${turn.index}:${turn.prompt}:${turn.status}`)).toEqual([
            '0:anchor:done',
            '1:question:running'
        ]);

        // The stale stop text is GONE from the compiled row: `forgetProjections` dropped the
        // settled projector, so the row re-folded from the truncated record and now renders
        // the resumed attempt (`streaming`, no status line) instead of `cancelled`.
        expect(rowOf(store, created.id, 1)).toEqual({ index: 1, status: 'running', state: 'streaming' });

        // The replay is really executing (parked on the anchor gate), and the conversation is
        // no longer stopped: the runtime's host-revival path ran on this row's behalf.
        await waitUntil(() => fixture.log.filter((entry) => entry === 'start:question').length === 2);
        expect(store.liveSession(created.id).harness.thread('thread-1')!.status).toBe('running');

        fixture.gate('anchor').resolve();
        await resumed.settled;
        await store.waitForIdle(created.id);

        // THE LEDGER AFTER: still two rows. The second one answered, in the same
        // conversation, and the conversation is addressable again.
        expect(store.get(created.id).turns.map((turn) => `${turn.index}:${turn.prompt}:${turn.status}`)).toEqual([
            '0:anchor:done',
            '1:question:done'
        ]);
        expect(store.get(created.id).threads!.map((thread) => `${thread.id}:${thread.status}`)).toEqual([
            'thread-1:idle'
        ]);
        expect(rowOf(store, created.id, 1)).toEqual({ index: 1, status: 'done', state: 'done', detail: 'scripted/test' });

        // The transcript proves the resumed run asked the SAME question in the SAME
        // conversation: the anchor answer is still in front of it and nothing is repeated.
        expect(fixture.log).toEqual([
            'start:anchor',
            'end:anchor',
            'start:question',
            'end:question',
            'start:question',
            'end:question'
        ]);
        expect(lastUser(fixture.requests[fixture.requests.length - 1]!)).toBe('question');
        expect(
            fixture.requests[fixture.requests.length - 1]!
                .filter((message) => message.role === 'user')
                .map((message) => String(message.content))
        ).toEqual(['anchor', 'question']);
    });

    it('refuses every conversation this route is not for, whatever its newest row is', async () => {
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        // 404s come first, in `cancelThread`'s exact wording, so one typo cannot 409.
        await expect(store.resumeThread('missing', 'thread-1')).rejects.toThrow('Unknown session "missing".');
        await expect(store.resumeThread(created.id, 'thread-404')).rejects.toThrow('Unknown thread "thread-404".');

        // REV2: an IDLE conversation IS resumable now — what decides is its newest row. This one
        // answered, so the refusal is the answer-reached guard, not the status guard: the state
        // a stop-after-answer leaves behind, which the v1 status gate refused with its own
        // sentence and this route now refuses with the true one.
        const answered = await store.enqueue(created.id, 'answered');
        await answered.settled;
        await expect(store.resumeThread(created.id, 'thread-1')).rejects.toThrow(
            'Thread "thread-1" already reached its answer (turn 0 is done).'
        );

        // A RUNNING conversation has work in flight. Its wording is UNCHANGED by rev2: `running`
        // is the state that sentence still describes, and the route's contract names it.
        fixture.gate('running');
        const live = await store.enqueue(created.id, 'running', undefined, undefined, 'thread-1');
        await fixture.started('running').promise;
        await expect(store.resumeThread(created.id, 'thread-1')).rejects.toThrow(
            'Thread "thread-1" is running; only a stopped thread can be resumed.'
        );
        fixture.gate('running').resolve();
        await live.settled;
        await store.waitForIdle(created.id);

        // THE REQUEST'S OWN BOUNDARY, unchanged: "as long as the answer isn't reached". A stopped
        // thread whose LAST turn is `done` reached its answer, so re-running it would only
        // duplicate it.
        await store.cancelThread(created.id, 'thread-1');
        expect(store.get(created.id).threads![0]).toEqual(expect.objectContaining({ id: 'thread-1', status: 'stopped' }));
        await expect(store.resumeThread(created.id, 'thread-1')).rejects.toThrow(
            'Thread "thread-1" already reached its answer (turn 1 is done).'
        );

        // REV2: `paused` is the roster's fourth status and the route's own guard now names it.
        // A paused conversation is a PLUGIN park the runtime unparks on its control, so this
        // route states that it does not own it rather than reusing the running sentence — and it
        // says so BEFORE looking at the rows, because the park is the whole reason.
        // `setThreadStatus` is the T5 seam that writes a roster status onto a conversation with
        // no run attached here (./harness.ts:5424), which is the only honest way to fixture it.
        store.liveSession(created.id).harness.setThreadStatus('thread-1', 'paused');
        await expect(store.resumeThread(created.id, 'thread-1')).rejects.toThrow(
            'Thread "thread-1" is paused; the plugin that parked it unpauses it, not this route.'
        );
    });

    // REV2 (R1): THE SERVER-ERROR CASE, NO RESTART INVOLVED. A run that fails on the provider
    // settles its row `error` and returns its conversation to `idle` — no stop was ever asked,
    // so the v1 status gate matched nothing and the row was stranded with only Delete and
    // Transcript beside it. The row itself is the input, so this route replays it exactly like a
    // stopped one.
    it('re-runs the errored row of a conversation the host never stopped', async () => {
        pinClock(1_000);
        const provider = flakyFixture();
        const store = createStore([provider.preset]);
        const created = await store.create('probe');

        const failed = await store.enqueue(created.id, 'question');
        await failed.settled;
        await store.waitForIdle(created.id);

        // THE STATE RESUME STARTS FROM: an `error` row, an `idle` conversation, and the session
        // still reporting the failure (that pair is the pane's banner, so the resume's promise
        // about the banner is pinned in the restart test below).
        expect(store.get(created.id).turns.map((turn) => `${turn.index}:${turn.status}`)).toEqual(['0:error']);
        expect(store.get(created.id).threads!.map((thread) => `${thread.id}:${thread.status}`)).toEqual([
            'thread-1:idle'
        ]);
        expect(store.get(created.id).lastError).toBe('provider exploded');

        // The provider is healthy again BEFORE the replay is asked for, so the row reaching
        // `done` below can only be the resumed attempt.
        provider.heal();

        const resumed = await store.resumeThread(created.id, 'thread-1');

        // THE SAME ROW: same id, same index, `queued` as accepted, and none of the failed
        // attempt's frames (it never reached a committed step), so the resumed run is the only
        // answer the transcript will show.
        expect(resumed.turn).toEqual({
            id: failed.turn.id,
            index: 0,
            prompt: 'question',
            threadId: 'thread-1',
            threadLabel: 'PE1',
            status: 'queued',
            updatedAt: 1_000,
            events: [],
            eventTimes: []
        });

        await resumed.settled;
        await store.waitForIdle(created.id);

        // ONE row, answered, and the ledger did not grow: `resume` did not append a second
        // `question`, and the session's failure banner is gone with the answered row.
        expect(store.get(created.id).turns.map((turn) => `${turn.index}:${turn.prompt}:${turn.status}`)).toEqual([
            '0:question:done'
        ]);
        expect(store.get(created.id).lastError).toBeUndefined();
        expect(rowOf(store, created.id, 0)).toEqual({
            index: 0,
            status: 'done',
            state: 'done',
            detail: 'scripted/test'
        });
    });

    // REV2 (R1 + R2): THE CASE IN THE REPORTED SCREENSHOT. The runtime persists a conversation's
    // status as only `stopped` or `idle`, so a run that was in flight when the process died
    // comes back as an `error` row on an `idle` conversation — and the restore writes a
    // SESSION-level pair with it (`status: 'error'` plus the restart sentence as `lastError`,
    // ./sessions.ts:3286-3297), which is what the shell paints as the red "it was not replayed"
    // note. Two things are pinned here: the note's promise is now true (the SAME row is re-run,
    // in place, to an answer), and the note is retired by the requeue's own durable write —
    // including the case where that write fails, which puts the banner back exactly as it was.
    it('re-runs the row a server restart interrupted and retires the restart banner', async () => {
        pinClock(3_000);
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't3-resume-restart-'));
        const fixture = createFixture();
        const persistence = new HarnessPersistence(root);
        const first = createStore([fixture.preset], persistence);
        const created = await first.create('probe');

        const anchor = await first.enqueue(created.id, 'anchor');
        await anchor.settled;

        // A run in flight AT THE CRASH: the anchor gate holds it (the fixture routes on the
        // conversation's FIRST prompt), so its row is durably `running` when the process dies.
        fixture.gate('anchor');
        const interrupted = await first.enqueue(created.id, 'question', undefined, undefined, 'thread-1');
        await fixture.started('question').promise;

        // THE CRASH: a fresh store over the same root. `first` is never disposed and its run
        // stays parked on the gate, so nothing but this store writes the file from here.
        const second = createStore([fixture.preset], persistence, persistence.load());

        // Exactly the reported state: the ledger still names the SAME row (no duplicate), it is
        // `error`, its conversation is `idle`, and the session carries the restart banner.
        expect(second.get(created.id).turns.map((turn) => `${turn.index}:${turn.status}`)).toEqual(['0:done', '1:error']);
        expect(second.get(created.id).threads!.map((thread) => `${thread.id}:${thread.status}`)).toEqual([
            'thread-1:idle'
        ]);
        expect(second.get(created.id).status).toBe('error');
        expect(second.get(created.id).lastError).toBe(RESTART_BANNER);

        // A write that FAILS puts the banner back: a requeue that never became durable did not
        // replay anything, so "it was not replayed" is the truth again — row, status and note are
        // exactly what the restore wrote.
        const save = vi.spyOn(persistence, 'save').mockImplementation(() => {
            throw new Error('disk full');
        });

        let refused: unknown;

        try {
            await second.resumeThread(created.id, 'thread-1');
        } catch (error) {
            refused = error;
        }

        expect(refused).toMatchObject({ status: 500 });
        save.mockRestore();

        expect(second.get(created.id).turns.map((turn) => `${turn.index}:${turn.status}`)).toEqual(['0:done', '1:error']);
        expect(second.get(created.id).status).toBe('error');
        expect(second.get(created.id).lastError).toBe(RESTART_BANNER);

        // THE RESUME, ACCEPTED: the same row, back in the shape a submit mints (the restarted
        // row's single `start` frame is after the last committed step, so nothing of the dead
        // attempt is kept).
        const resumed = await second.resumeThread(created.id, 'thread-1');

        expect(resumed.turn).toEqual({
            id: interrupted.turn.id,
            index: 1,
            prompt: 'question',
            threadId: 'thread-1',
            threadLabel: 'PE1',
            status: 'queued',
            updatedAt: 3_000,
            events: [],
            eventTimes: []
        });

        // THE BANNER, THE MOMENT THE REPLAY IS ACCEPTED: the note's text is gone from the record
        // AND from the document the next process would read (`status` is not pinned here because
        // the lane has already opened the run in this same tick — `last_error` is the half the
        // note actually reads, and the pump clears nothing until its own turn-start write).
        expect(second.get(created.id).lastError).toBeUndefined();

        const onDisk = persistence.load()?.sessions.find((record) => record.id === created.id);

        expect(onDisk?.lastError).toBeUndefined();

        // THE REPLAY RUNS TO AN ANSWER: one row per question, both answered, the conversation
        // addressable again, and the session idle with nothing to report.
        fixture.gate('anchor').resolve();
        await resumed.settled;
        await second.waitForIdle(created.id);

        expect(second.get(created.id).turns.map((turn) => `${turn.index}:${turn.prompt}:${turn.status}`)).toEqual([
            '0:anchor:done',
            '1:question:done'
        ]);
        expect(second.get(created.id).threads!.map((thread) => `${thread.id}:${thread.status}`)).toEqual([
            'thread-1:idle'
        ]);
        expect(second.get(created.id).status).toBe('idle');
        expect(second.get(created.id).lastError).toBeUndefined();
        expect(rowOf(second, created.id, 1)).toEqual({
            index: 1,
            status: 'done',
            state: 'done',
            detail: 'scripted/test'
        });

        await interrupted.settled;
        first.dispose();
        second.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('requeues the row synchronously so two resumes in one tick cannot run it twice', async () => {
        pinClock(1_000);
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        const anchor = await store.enqueue(created.id, 'anchor');
        await anchor.settled;

        fixture.gate('anchor');
        const interrupted = await store.enqueue(created.id, 'question', undefined, undefined, 'thread-1');
        await fixture.started('question').promise;
        await store.cancelThread(created.id, 'thread-1');
        await interrupted.settled;
        await store.waitForIdle(created.id);

        // Dispatched together. The FIRST call flips the row to `queued` before its first
        // await, so the SECOND caller reads that state and is refused by the newest-turn
        // guard — the state the first call really produced, stated in its own words.
        const [accepted, refused] = await Promise.allSettled([
            store.resumeThread(created.id, 'thread-1'),
            store.resumeThread(created.id, 'thread-1')
        ]);

        expect(accepted.status).toBe('fulfilled');
        expect(refused).toEqual({
            status: 'rejected',
            reason: expect.objectContaining({
                name: 'SessionError',
                status: 409,
                message: 'Thread "thread-1" still has turn 1 queued.'
            })
        });

        const resumed = (accepted.value as Awaited<ReturnType<SessionStore['resumeThread']>>).turn;

        // ONE row carries the re-run input, and it is the interrupted row itself: no third
        // row, and the cancelled turn is not left behind next to its own retry.
        expect(resumed.id).toBe(interrupted.turn.id);
        expect(store.get(created.id).turns).toHaveLength(2);

        // Parked on the anchor gate, the resumed run is verifiably RUNNING before the next
        // call, so the refusal below is the state the first resume produced (R1's "already
        // running" race), not a timing artefact of a pump that had not started yet.
        await waitUntil(() => store.liveSession(created.id).harness.thread('thread-1')!.status === 'running');
        await expect(store.resumeThread(created.id, 'thread-1')).rejects.toThrow(
            'Thread "thread-1" is running; only a stopped thread can be resumed.'
        );

        fixture.gate('anchor').resolve();
        await store.waitForIdle(created.id);
        expect(store.get(created.id).turns.map((turn) => `${turn.index}:${turn.status}`)).toEqual(['0:done', '1:done']);
    });

    it('stops and re-runs the SAME row again when a resumed run is itself stopped', async () => {
        pinClock(1_000);
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        const anchor = await store.enqueue(created.id, 'anchor');
        await anchor.settled;

        fixture.gate('anchor');
        const interrupted = await store.enqueue(created.id, 'question', undefined, undefined, 'thread-1');
        await fixture.started('question').promise;
        await store.cancelThread(created.id, 'thread-1');
        await interrupted.settled;
        await store.waitForIdle(created.id);

        // First resume: the row runs again under its own id.
        const first = await store.resumeThread(created.id, 'thread-1');
        await waitUntil(() => store.liveSession(created.id).harness.thread('thread-1')!.status === 'running');

        // Stopping a RESUMED run is the same stop as the first one — same row, same `cancelled`
        // mark, same stopped conversation, and still no extra row anywhere.
        expect((await store.cancelThread(created.id, 'thread-1')).cancelled).toBe(true);
        await first.settled;
        await store.waitForIdle(created.id);

        expect(store.get(created.id).turns.map((turn) => `${turn.index}:${turn.prompt}:${turn.status}`)).toEqual([
            '0:anchor:done',
            '1:question:cancelled'
        ]);
        expect(store.get(created.id).turns[1]!.id).toBe(interrupted.turn.id);

        // Second resume of the same conversation: the newest turn is unanswered again, so the
        // route is open again, and the row it puts back is still the ORIGINAL one.
        const second = await store.resumeThread(created.id, 'thread-1');
        expect({
            id: second.turn.id,
            index: second.turn.index,
            status: second.turn.status,
            eventCount: second.turn.events.length
        }).toEqual({ id: interrupted.turn.id, index: 1, status: 'queued', eventCount: 0 });

        fixture.gate('anchor').resolve();
        await second.settled;
        await store.waitForIdle(created.id);

        // Two attempts were abandoned and one answered: the ledger is still the same two rows,
        // and the conversation ran three times in one transcript with the question asked once.
        expect(store.get(created.id).turns.map((turn) => `${turn.index}:${turn.prompt}:${turn.status}`)).toEqual([
            '0:anchor:done',
            '1:question:done'
        ]);
        expect(store.get(created.id).threads!.map((thread) => `${thread.id}:${thread.status}`)).toEqual([
            'thread-1:idle'
        ]);
        expect(fixture.log).toEqual([
            'start:anchor',
            'end:anchor',
            'start:question',
            'end:question',
            'start:question',
            'end:question',
            'start:question',
            'end:question'
        ]);
        expect(
            fixture.requests[fixture.requests.length - 1]!
                .filter((message) => message.role === 'user')
                .map((message) => String(message.content))
        ).toEqual(['anchor', 'question']);
    });

    it('re-runs the interrupted row with its attachments and result references', async () => {
        pinClock(1_000);
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        const base = await store.enqueue(created.id, 'base');
        await base.settled;

        // Hold the session's exclusive gate with a legacy run, so a lane submit QUEUES: the
        // interrupted turn is then a backlog row the stop marks `cancelled` without ever
        // running it, which keeps every value below known before it is asserted.
        fixture.gate('legacy');
        const legacy = store.run(created.id, 'legacy', async () => {});
        await fixture.started('legacy').promise;

        const attachment = {
            id: 'image-1',
            kind: 'image' as const,
            marker: '[Image 1]',
            name: 'pixel.png',
            mime: 'image/png',
            size: 8,
            data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
        };

        const interrupted = await store.enqueue(
            created.id,
            'with media',
            [attachment],
            [{ turnId: base.turn.id, label: 'PE1' }],
            'thread-1'
        );
        expect(interrupted.turn.status).toBe('queued');

        await store.cancelThread(created.id, 'thread-1');
        await interrupted.settled;

        const stopped = store.get(created.id).turns.at(-1)!;
        expect(stopped.status).toBe('cancelled');

        const resumed = await store.resumeThread(created.id, 'thread-1');

        // FULL FIDELITY IN THE SAME ROW: the durable record keeps the prompt, the accepted
        // attachment bytes and the bound reference list, and the requeue carries all three
        // unchanged (./persistence.ts revalidates each on load, so a restart has the same
        // record to re-run). The id and index are the cancelled row's, not a new pair.
        expect(resumed.turn).toEqual({
            id: interrupted.turn.id,
            index: 2,
            prompt: 'with media',
            threadId: 'thread-1',
            threadLabel: 'PE1',
            references: [{ turnId: base.turn.id, label: 'PE1' }],
            attachments: [attachment],
            status: 'queued',
            updatedAt: 1_000,
            events: [],
            eventTimes: []
        });

        // The requeue is accepted but NOT yet running (the legacy run holds the session's
        // exclusive gate, so the lane parks). A second resume therefore reads the row the first
        // one requeued and refuses it as work in flight — the claim is not what keeps this tight.
        await expect(store.resumeThread(created.id, 'thread-1')).rejects.toThrow(
            'Thread "thread-1" still has turn 2 queued.'
        );

        fixture.gate('legacy').resolve();
        await legacy;
        await resumed.settled;
        await store.waitForIdle(created.id);

        // THREE rows, and only because the session has three pieces of work in it: the base
        // answer, the legacy run, and the media row — which answered under its ORIGINAL index.
        expect(store.get(created.id).turns.map((turn) => `${turn.index}:${turn.prompt}:${turn.status}`)).toEqual([
            '0:base:done',
            '1:legacy:done',
            '2:with media:done'
        ]);

        // And the run it produces is the run the interrupted turn would have had: the reference
        // is re-expanded at execution (the stored prompt is the SUBMITTED text, so the block
        // content is folded in by the same expansion the interrupted turn used), and the
        // attachment rides along with it.
        const expanded = [
            'with media',
            '',
            REFERENCED_RESULTS_HEADER,
            `--- #PE1 | agent probe | turn ${base.turn.id} ---`,
            'answer:base',
            '--- end #PE1 ---',
            REFERENCED_RESULTS_FOOTER
        ].join('\n');
        const request = fixture.requests[fixture.requests.length - 1]!;

        expect(lastUser(request)).toBe(expanded);
        expect(request.filter((message) => message.role === 'user' && message.attachments !== undefined)).toEqual([
            { role: 'user', content: expanded, attachments: [attachment] }
        ]);
    });

    it('re-runs a command-shaped interrupted input as its own command turn', async () => {
        pinClock(1_000);
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        // THE ONE INPUT THIS ROUTE CANNOT REQUEUE. Only a direct `enqueue` produces a thread
        // row whose recorded text is command-shaped (the /tasks route routes a leading `/` to
        // the command path), and it is exactly the shape with no lane backlog to put back: a
        // command turn is born running and never joins a lane. So it keeps the pre-existing
        // new-row path, and re-runs as the COMMAND it was rather than as a prompt.
        fixture.gate('/help');
        const interrupted = await store.enqueue(created.id, '/help');
        await fixture.started('/help').promise;
        await store.cancelThread(created.id, 'thread-1');
        fixture.gate('/help').resolve();
        await interrupted.settled;
        await store.waitForIdle(created.id);

        expect(store.get(created.id).turns.map((turn) => `${turn.index}:${turn.prompt}:${turn.status}`)).toEqual([
            '0:/help:cancelled'
        ]);

        // Two resumes in one tick: THIS is the path the lane claim exists for. The command
        // turn appears only after `dispatch` has awaited, so the second caller is refused by
        // the claim, in its own words.
        const [accepted, refused] = await Promise.allSettled([
            store.resumeThread(created.id, 'thread-1'),
            store.resumeThread(created.id, 'thread-1')
        ]);

        expect(accepted.status).toBe('fulfilled');
        expect(refused).toEqual({
            status: 'rejected',
            reason: expect.objectContaining({
                name: 'SessionError',
                status: 409,
                message: 'Thread "thread-1" is already being resumed.'
            })
        });

        const command = (accepted.value as Awaited<ReturnType<SessionStore['resumeThread']>>).turn;

        // A NEW record (the command path mints its own, terminal-before-the-receipt row),
        // NOT the interrupted row: a command has no lane row to requeue and no answer to
        // reach, so the cancelled row stays as the stop's record beside it.
        expect(command.id).not.toBe(interrupted.turn.id);
        expect({
            index: command.index,
            prompt: command.prompt,
            status: command.status,
            threadId: command.threadId,
            threadLabel: command.threadLabel,
            eventTypes: command.events.map((event) => event.type)
        }).toEqual({
            index: 1,
            prompt: '/help',
            status: 'done',
            threadId: undefined,
            threadLabel: undefined,
            eventTypes: ['start', 'tool_call', 'tool_result']
        });

        expect(store.get(created.id).turns.map((turn) => `${turn.index}:${turn.prompt}:${turn.status}`)).toEqual([
            '0:/help:cancelled',
            '1:/help:done'
        ]);

        // A command acts on the SESSION, never on a conversation, so it does not revive the
        // stopped thread — and the route stays resumable once the command row is terminal.
        expect(store.get(created.id).threads!.map((thread) => `${thread.id}:${thread.status}`)).toEqual([
            'thread-1:stopped'
        ]);
    });

    it('rolls the abandoned attempt back to its committed step and re-bills the row', async () => {
        pinClock(1_000);

        // A scripted conversation whose FIRST request COMMITS a step (a tool round closes the
        // attempt window with `attempt_commit`, ../harness.ts:9231-9252 — the same boundary
        // the runtime splices back to on a stop) and whose SECOND request is the one the stop
        // interrupts. That is the state an in-place retry has to split in the record: keep
        // what history accepted, drop what the abandoned request streamed.
        let requests = 0;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let parked!: () => void;
        const secondRequest = new Promise<void>((resolve) => {
            parked = resolve;
        });
        let finished!: () => void;
        const answered = new Promise<void>((resolve) => {
            finished = resolve;
        });

        const preset = presetOf('probe', (settings, progress) =>
            harness({
                agents: {
                    probe: agent({
                        model: settings.model,
                        instruction: 'sys',
                        tools: ['timeNow'],
                        stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                            requests += 1;

                            if (requests === 1) {
                                // The request that commits: its `usage` lands in the row, so
                                // the requeue's tally reset is observable.
                                yield {
                                    type: 'done',
                                    stopReason: 'tool_calls',
                                    toolCalls: [{ id: 'call-1', name: 'timeNow', arguments: '{}' }],
                                    usage: { input: 7, output: 3, total: 10 }
                                };
                                return;
                            }

                            if (requests === 2) {
                                parked();
                                await new Promise<void>((resolve, reject) => {
                                    request.signal?.addEventListener('abort', () => reject(new Error('The run was aborted.')), {
                                        once: true
                                    });
                                    held.then(resolve, reject);
                                });
                            }

                            yield { type: 'text', delta: 'final answer' };
                            yield {
                                type: 'done',
                                stopReason: 'stop',
                                toolCalls: [],
                                usage: { input: 12, output: 4, total: 16 }
                            };
                            finished();
                        }
                    })
                },
                primary: 'probe',
                presets: false,
                report: { progress }
            })
        );

        const store = createStore([preset]);
        const created = await store.create('probe');
        const interrupted = await store.enqueue(created.id, 'spend');

        await secondRequest;
        await store.cancelThread(created.id, 'thread-1');
        release();
        await interrupted.settled;
        await store.waitForIdle(created.id);

        // THE STATE RESUME STARTS FROM: a cancelled row that DID commit a step, billed for
        // it, and then recorded the stop's error.
        const stopped = store.get(created.id).turns[0]!;
        expect(stopped.status).toBe('cancelled');
        expect(stopped.usage).toEqual({ input: 7, output: 3, total: 10 });
        expect(stopped.events.map((event) => event.type)).toEqual([
            'start',
            'usage',
            'tool_call',
            'tool_result',
            'attempt_commit',
            'error'
        ]);

        const resumed = await store.resumeThread(created.id, 'thread-1');

        // THE SPLIT. The record stops at its last `attempt_commit`: the committed round is
        // kept, the abandoned request's frames and the stop's error are not. And the row's
        // `usage` is EMPTY, because the row now states the attempt in flight rather than the
        // spend of the run that was stopped.
        expect(resumed.turn.usage).toBeUndefined();
        expect(resumed.turn.startedAt).toBeUndefined();
        expect(resumed.turn.events.map((event) => event.type)).toEqual([
            'start',
            'usage',
            'tool_call',
            'tool_result',
            'attempt_commit'
        ]);
        expect(resumed.turn.events[4]).toEqual({
            type: 'attempt_commit',
            agent: 'probe',
            attempt: 1,
            maxAttempts: 11,
            thread: { id: '1' }
        });

        await waitUntil(() => requests === 3);
        await answered;
        await resumed.settled;
        await store.waitForIdle(created.id);

        // ONE row, answered, and its bill is the resumed attempt's ALONE: 12/4/16. A row that
        // had kept the aborted attempt's spend would read 19/7/26.
        const row = store.get(created.id).turns[0]!;
        expect(row.usage).toEqual({ input: 12, output: 4, total: 16 });
        expect(row.events.map((event) => event.type)).toEqual([
            'start',
            'usage',
            'tool_call',
            'tool_result',
            'attempt_commit',
            'start',
            'text',
            'usage',
            'done'
        ]);
        expect(store.get(created.id).turns).toHaveLength(1);
        expect(store.get(created.id).threads!.map((thread) => `${thread.id}:${thread.status}`)).toEqual([
            'thread-1:idle'
        ]);
    });

    it('refuses a stopped conversation that has no recorded turn of its own', async () => {
        const fixture = createFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        // A conversation the runtime opened (a delegated child, or an extra host thread) can be
        // stopped without this server ever recording a turn for it: there is no stored input to
        // re-run, and inventing one would be new persistence.
        const extra = store.liveSession(created.id).harness.createThread('probe');
        await store.cancelThread(created.id, extra.id);
        expect(store.get(created.id).threads!.find((thread) => thread.id === extra.id)!.status).toBe('stopped');

        await expect(store.resumeThread(created.id, extra.id)).rejects.toThrow(
            `Thread "${extra.id}" has no recorded turn to resume.`
        );
    });

    it('re-runs the interrupted row after a restart from the durable record', async () => {
        pinClock(3_000);
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't3-resume-'));
        const fixture = createFixture();
        const persistence = new HarnessPersistence(root);
        const first = createStore([fixture.preset], persistence);
        const created = await first.create('probe');

        const attachment = {
            id: 'image-1',
            kind: 'image' as const,
            marker: '[Image 1]',
            name: 'pixel.png',
            mime: 'image/png',
            size: 8,
            data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
        };

        fixture.gate('interrupted');
        const interrupted = await first.enqueue(created.id, 'interrupted', [attachment]);
        await fixture.started('interrupted').promise;
        await first.cancelThread(created.id, 'thread-1');
        fixture.gate('interrupted').resolve();
        await interrupted.settled;
        await first.waitForIdle(created.id);
        expect(first.get(created.id).turns.map((turn) => `${turn.prompt}:${turn.status}`)).toEqual([
            'interrupted:cancelled'
        ]);

        // A crash: a FRESH store over the same root, no dispose, nothing running or queued.
        const second = createStore([fixture.preset], persistence, persistence.load());

        // The stop survives (a `stopped` thread record and its `cancelled` row are durable), so
        // the re-run after a restart needs nothing but the stored turn: same prompt, same
        // conversation, same attachment bytes, SAME ROW. This is the proof the fidelity claim
        // is about the DURABLE record, not about process memory.
        expect(second.get(created.id).threads!.map((thread) => `${thread.id}:${thread.status}`)).toEqual([
            'thread-1:stopped'
        ]);
        expect(second.get(created.id).turns.map((turn) => `${turn.index}:${turn.status}`)).toEqual(['0:cancelled']);

        const resumed = await second.resumeThread(created.id, 'thread-1');
        expect(resumed.turn).toEqual({
            id: interrupted.turn.id,
            index: 0,
            prompt: 'interrupted',
            threadId: 'thread-1',
            threadLabel: 'PE1',
            attachments: [attachment],
            status: 'queued',
            updatedAt: 3_000,
            events: [],
            eventTimes: []
        });

        await resumed.settled;
        await second.waitForIdle(created.id);

        // ONE row for ONE question, and it answered: the restart-then-resume path never
        // leaves the cancelled record behind next to its own retry.
        expect(second.get(created.id).turns.map((turn) => `${turn.index}:${turn.prompt}:${turn.status}`)).toEqual([
            '0:interrupted:done'
        ]);

        first.dispose();
        second.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('restores only the resumed attempt when a restart interrupts a resume', async () => {
        pinClock(3_000);
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't3-resume-crash-'));
        const fixture = createFixture();
        const persistence = new HarnessPersistence(root);
        const first = createStore([fixture.preset], persistence);
        const created = await first.create('probe');

        const anchor = await first.enqueue(created.id, 'anchor');
        await anchor.settled;

        fixture.gate('anchor');
        const interrupted = await first.enqueue(created.id, 'question', undefined, undefined, 'thread-1');
        await fixture.started('question').promise;
        await first.cancelThread(created.id, 'thread-1');
        await interrupted.settled;
        await first.waitForIdle(created.id);

        const interruptedId = interrupted.turn.id;
        expect(first.get(created.id).turns[1]!.events.map((event) => event.type)).toEqual(['start', 'error']);

        // The resume is in flight (parked on the anchor gate) when the process dies: the live
        // row is `running` and holds ONLY the resumed attempt's frames.
        await first.resumeThread(created.id, 'thread-1');
        await waitUntil(() => fixture.log.filter((entry) => entry === 'start:question').length === 2);
        expect(first.get(created.id).turns.map((turn) => `${turn.index}:${turn.status}`)).toEqual(['0:done', '1:running']);
        expect(first.get(created.id).turns[1]!.events.map((event) => event.type)).toEqual(['start']);

        // A crash over the same root. The recovery policy marks the in-flight row `error`
        // (never replays it), and the ledger is still the TWO rows it was: same id, same
        // index, no duplicate created by the resume.
        const second = createStore([fixture.preset], persistence, persistence.load());

        expect(second.get(created.id).turns.map((turn) => `${turn.id}:${turn.index}:${turn.prompt}:${turn.status}`)).toEqual([
            `${anchor.turn.id}:0:anchor:done`,
            `${interruptedId}:1:question:error`
        ]);

        // THE JOURNAL-COMPACTION PROOF. The log is append-only per `(turnId, index)` and a
        // restore UNIONS it into the record, so a truncated row whose log still held the
        // aborted attempt's indices would come back with those events. It does not: the
        // restored row holds exactly the resumed attempt's one `start` frame — no resurrected
        // `error`, and no second copy of the run.
        expect(second.get(created.id).turns[1]!.events).toEqual([
            {
                type: 'start',
                agent: 'probe',
                model: 'scripted/test',
                thread: { id: '3', input: 'question' }
            }
        ]);
        expect(second.get(created.id).turns[1]!.eventTimes).toEqual([3_000]);

        // And the compiled row is folded from THAT record: an interrupted run whose status
        // line is the restart's, never the stale text of the stop that was already rolled back.
        const restored = second.getView(created.id).turns.find((summary) => summary.index === 1)!;
        expect({ status: restored.status, state: restored.state, detail: restored.detail }).toEqual({
            status: 'error',
            state: 'error',
            detail: undefined
        });

        first.dispose();
        second.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
});

// ---------------------------------------------------------------------------
// R1 (HTTP): POST /sessions/:id/threads/:threadId/resume
// ---------------------------------------------------------------------------

describe('thread resume HTTP contract', () => {
    const runtimeOf = (presets: HarnessPreset[]): HarnessRuntime =>
        createHarnessRuntime({
            settings: SETTINGS,
            defaults: RUNTIME_DEFAULTS,
            store: new SessionStore(SETTINGS, createHarnessRegistry(presets)),
            loadEnvironment: false
        });

    const turnOf = async (runtime: HarnessRuntime, sessionId: string, turnId: string): Promise<TurnResource> => {
        const result = await jsonOf<TurnResponse>(
            await callApi(runtime, 'GET', `/v1/harness/sessions/${sessionId}/turns/${turnId}`)
        );

        expect(result.status).toBe(200);
        return result.body.turn;
    };

    const threadRosterOf = async (runtime: HarnessRuntime, sessionId: string): Promise<ThreadSummary[]> => {
        const result = await jsonOf<ThreadSummaryPage>(
            await callApi(runtime, 'GET', `/v1/harness/sessions/${sessionId}/threads`)
        );

        expect(result.status).toBe(200);
        return result.body.items;
    };

    const turnRowsOf = async (runtime: HarnessRuntime, sessionId: string): Promise<TurnSummary[]> => {
        const result = await jsonOf<TurnSummaryPage>(
            await callApi(runtime, 'GET', `/v1/harness/sessions/${sessionId}/turns`)
        );

        expect(result.status).toBe(200);
        return result.body.items;
    };

    it('answers the submit receipt and re-runs the interrupted prompt', async () => {
        pinClock(2_000);
        const fixture = createFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'probe');

        // Anchor turn, then a `question` run parked on the anchor gate and stopped: the
        // conversation's last row is the cancelled `question` the route has to replay.
        const anchor = await jsonOf<TaskReceipt>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, { input: 'anchor' })
        );
        expect(anchor.status).toBe(202);
        await runtime.store.waitForIdle(id);

        fixture.gate('anchor');
        void callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, { input: 'question', thread_id: 'thread-1' });
        await fixture.started('question').promise;

        expect(
            (await jsonOf<CancelThreadResult>(
                await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/threads/thread-1/cancel`)
            )).status
        ).toBe(200);
        await runtime.store.waitForIdle(id);

        // THE ROW THE ROUTE MUST PUT BACK: the cancelled `question` record, read from the
        // durable page so the receipt's identity claim below is pinned against the row that
        // already exists rather than against a figure the route could have minted.
        const cancelled = (await turnRowsOf(runtime, id)).find((row) => row.promptPreview === 'question')!;
        expect({ index: cancelled.index, status: cancelled.status, threadId: cancelled.threadId }).toEqual({
            index: 1,
            status: 'cancelled',
            threadId: 'thread-1'
        });

        const resumed = await jsonOf<TaskReceipt>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/threads/thread-1/resume`)
        );

        // 200 + the SAME `TaskReceipt` a normal submit answers with (the fixed contract), with
        // no steering marker: this is the interrupted row re-running, not guidance folded into
        // a run, and not a new row either — the receipt names the cancelled turn's OWN id. No
        // `queue_position` either: the lane was free, so the pump moved the requeued row straight
        // into its active slot — exactly how an ordinary continuation into a free thread reads.
        // The two identity/revision fields are pinned by the turns call below.
        expect(resumed.status).toBe(200);
        expect(resumed.body).toEqual({
            session_id: id,
            turn_id: cancelled.id,
            status: 'queued',
            thread_id: 'thread-1',
            session_revision: resumed.body.session_revision,
            accepted_at: 2_000,
            links: {
                turn: `/v1/harness/sessions/${id}/turns/${cancelled.id}`,
                turns: `/v1/harness/sessions/${id}/turns`,
                thread: `/v1/harness/sessions/${id}/threads/thread-1`,
                stream: '/v1/harness/stream'
            }
        });

        // The recorded row IS the interrupted row: same id, same index, the same input, in the
        // same conversation with the same label. The read happens after the pump started it, and
        // the run is parked on the anchor gate, so the row is `running` while the receipt above
        // stated the accepted state (`queued`) — the same pair every submit's receipt and later
        // read show.
        expect(await turnOf(runtime, id, cancelled.id)).toMatchObject({
            id: cancelled.id,
            index: 1,
            prompt: 'question',
            thread_id: 'thread-1',
            thread_label: 'PE1',
            status: 'running'
        });

        // The lane backlog parked on the anchor gate, so the roster row states the revival.
        expect((await threadRosterOf(runtime, id)).find((row) => row.id === 'thread-1')!.status).toBe('running');

        fixture.gate('anchor').resolve();
        await runtime.store.waitForIdle(id);

        // The page is the durable proof of what the resume did: TWO rows, the second one the
        // interrupted turn re-run in place (same id as the row the stop left, now `done`), and
        // the conversation addressable again (`idle`, not `stopped`). The same question never
        // appears twice on the page.
        const rows = await turnRowsOf(runtime, id);

        expect(rows.map((row) => `${row.index}:${row.threadId}:${row.promptPreview}:${row.status}`)).toEqual([
            '0:thread-1:anchor:done',
            '1:thread-1:question:done'
        ]);
        expect(rows[1]!.id).toBe(cancelled.id);
        expect(rows.filter((row) => row.promptPreview === 'question')).toHaveLength(1);
        expect((await threadRosterOf(runtime, id)).find((row) => row.id === 'thread-1')!.status).toBe('idle');

        // A conversation that answered again is no longer resumable. Rev2 accepts its `idle`
        // status, so the refusal is now the TRUE reason — the answer was reached — and not the
        // v1 status guard that happened to fire first.
        const again = await jsonOf<{ error: { message: string } }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/threads/thread-1/resume`)
        );
        expect(again).toEqual({
            status: 409,
            body: { error: { message: 'Thread "thread-1" already reached its answer (turn 1 is done).' } }
        });
    });

    it('refuses the states this route is not for, and 404s an unknown conversation', async () => {
        const fixture = createFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'probe');

        // Unknown conversation in a known session: 404, scoped to the session in the path, in
        // `cancel`/`delete`'s exact wording.
        const unknownThread = await jsonOf<{ error: { message: string } }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/threads/thread-404/resume`)
        );
        expect(unknownThread).toEqual({
            status: 404,
            body: { error: { message: `Unknown thread "thread-404" in session "${id}".` } }
        });

        // Unknown session: the store's own 404, unchanged by the route.
        const unknownSession = await jsonOf<{ error: { message: string } }>(
            await callApi(runtime, 'POST', '/v1/harness/sessions/gone/threads/thread-1/resume')
        );
        expect(unknownSession).toEqual({ status: 404, body: { error: { message: 'Unknown session "gone".' } } });

        // A session that has never run has no host conversation at all: the default
        // conversation is `agent:<name>`, and `thread-1` only exists once a submit opens one.
        const neverOpened = await jsonOf<{ error: { message: string } }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/threads/thread-1/resume`)
        );
        expect(neverOpened).toEqual({
            status: 404,
            body: { error: { message: `Unknown thread "thread-1" in session "${id}".` } }
        });

        const answered = await jsonOf<TaskReceipt>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, { input: 'answered' })
        );
        expect(answered.status).toBe(202);
        await runtime.store.waitForIdle(id);

        // REV2: this is the conversation the restart case leaves behind — `idle`, with its
        // newest row answered — and it is now refused by the ANSWER guard rather than by the
        // status guard. The status guard is what made the v1 route unreachable for an
        // interrupted run, because the runtime persists a conversation as `stopped` or `idle`
        // only and a crash therefore lands on an `idle` one.
        const idle = await jsonOf<{ error: { message: string } }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/threads/thread-1/resume`)
        );
        expect(idle).toEqual({
            status: 409,
            body: { error: { message: 'Thread "thread-1" already reached its answer (turn 0 is done).' } }
        });

        // Stop an IDLE conversation: it is now stopped, but its last turn answered, so the
        // request's own "as long as the answer isn't reached" bound refuses the replay.
        expect(
            (await jsonOf<CancelThreadResult>(
                await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/threads/thread-1/cancel`)
            )).status
        ).toBe(200);

        const reached = await jsonOf<{ error: { message: string } }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/threads/thread-1/resume`)
        );
        expect(reached).toEqual({
            status: 409,
            body: { error: { message: 'Thread "thread-1" already reached its answer (turn 0 is done).' } }
        });
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
                                                name: 'delegate',
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
        const created = await store.create('lead');

        const task = await store.enqueue(created.id, 'delegate please');
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
        const deleted = await store.deleteThread(created.id, 'thread-1');
        expect(deleted.threads).toBeUndefined();
        expect(deleted.turns).toEqual([]);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('purges the deleted child result from the persisted agent-result registry (F6)', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't4-threads-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore([delegationPreset()], persistence);
        const created = await store.create('lead');

        const task = await store.enqueue(created.id, 'delegate please');
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

        await store.deleteThread(created.id, 'thread-2');

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

    // R3 IDENTITY: a submit addressed to a delegated child is a CONTINUATION of
    // that conversation — the same id and owner, its own turn/lane, and no extra
    // thread. The parent transcript is untouched and a restart keeps the routing.
    it('resumes a delegated child through a focused submit without minting a thread', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't4-threads-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore([delegationPreset()], persistence);
        const created = await store.create('lead');

        // Parent submit opens thread-1; its delegation opens the owned child
        // thread-2 (invocations: parent 1, child 2).
        const task = await store.enqueue(created.id, 'delegate please');
        await task.settled;
        await store.waitForIdle(created.id);

        const before = store.get(created.id);
        expect(before.threads!.map((thread) => [thread.id, thread.ownerThreadId, thread.label])).toEqual([
            ['thread-1', undefined, 'LD1'],
            ['thread-2', 'thread-1', 'HR1']
        ]);
        // R3: the historical roster starts with the runs observed so far — the parent's
        // root run and the child's ORIGINAL delegated run, each on its own thread.
        expect(before.threads!.map((thread) => thread.invocationIds)).toEqual([['1'], ['2']]);
        const parentMessages = transcript(before.threads![0].messages);
        expect(parentMessages).toEqual([
            { role: 'system', content: 'lead' },
            { role: 'user', content: 'delegate please' },
            { role: 'assistant', content: '' },
            // T28: the delegate result is an envelope (identity + paged answer).
            { role: 'tool', content: expect.stringContaining('"agent":"helper","content":"helper answer"') },
            { role: 'assistant', content: 'lead answer' }
        ]);

        // A focused submit addresses the CHILD conversation by its persistent id.
        const continuation = await store.enqueue(created.id, 'continue child', undefined, undefined, 'thread-2');
        expect(continuation.turn.threadId).toBe('thread-2');
        // The conversation keeps its own display name (it is the same thread).
        expect(continuation.turn.threadLabel).toBe('HR1');

        await continuation.settled;
        await store.waitForIdle(created.id);

        const after = store.get(created.id);
        // No thread was minted: the continuation reused the child conversation.
        expect(after.threads!.map((thread) => thread.id)).toEqual(['thread-1', 'thread-2']);
        expect(
            after.threads!.map((thread) => [
                thread.id,
                thread.ownerThreadId,
                thread.invocationId,
                thread.originTurnId === continuation.turn.id
            ])
        ).toEqual([
            ['thread-1', undefined, '1', false],
            ['thread-2', 'thread-1', '3', true]
        ]);
        // R3: the resume ADVANCES the single slot but the historical roster keeps the
        // original delegated run, so a client can still bind the card it created.
        // Neither thread gains the other's ids (no cross-thread leakage, no duplicate).
        expect(after.threads!.map((thread) => thread.invocationIds)).toEqual([
            ['1'],
            ['2', '3']
        ]);
        // The child conversation accumulated the focused turn; the parent did not.
        expect(transcript(after.threads![1].messages)).toEqual([
            { role: 'system', content: 'helper' },
            { role: 'user', content: 'child work' },
            { role: 'assistant', content: 'helper answer' },
            { role: 'user', content: 'continue child' },
            { role: 'assistant', content: 'helper answer' }
        ]);
        expect(transcript(after.threads![0].messages)).toEqual(parentMessages);

        // The focused submit's own turn records its invocation identity, joined to
        // the child conversation through the roster (no parent/call: it is a host
        // turn of an existing thread).
        expect(after.turns.map((turn) => [turn.prompt, turn.threadId, turn.threadLabel, turn.status])).toEqual([
            ['delegate please', 'thread-1', 'LD1', 'done'],
            ['continue child', 'thread-2', 'HR1', 'done']
        ]);
        expect(after.turns[1].events[0]).toEqual({
            type: 'start',
            agent: 'helper',
            model: 'scripted/test',
            thread: { id: '3', input: 'continue child' }
        });

        store.dispose();

        // Restart: both conversations, the owner link, and the transcript survive;
        // the NEXT focused submit continues the same child (invocation 4) again
        // without minting a thread.
        const reloaded = createStore([delegationPreset()], persistence, persistence.load());
        const restored = reloaded.get(created.id);
        expect(
            restored.threads!.map((thread) => [thread.id, thread.ownerThreadId, thread.invocationId, thread.label])
        ).toEqual([
            ['thread-1', undefined, '1', 'LD1'],
            ['thread-2', 'thread-1', '3', 'HR1']
        ]);
        // R3 (restart): the historical roster is derived from the PERSISTED
        // invocation→thread map, so a fresh page after a restart can still join the
        // card created by the child's original delegated run.
        expect(restored.threads!.map((thread) => thread.invocationIds)).toEqual([
            ['1'],
            ['2', '3']
        ]);
        expect(transcript(restored.threads![1].messages)).toEqual(
            transcript(after.threads![1].messages)
        );

        const resumed = await reloaded.enqueue(created.id, 'after restart', undefined, undefined, 'thread-2');
        await resumed.settled;
        await reloaded.waitForIdle(created.id);

        const final = reloaded.get(created.id);
        expect(final.threads!.map((thread) => [thread.id, thread.ownerThreadId, thread.invocationId])).toEqual([
            ['thread-1', undefined, '1'],
            ['thread-2', 'thread-1', '4']
        ]);
        // The post-restart resume APPENDS to the surviving history: the original
        // delegated run and the pre-restart continuation stay joinable, and the parent
        // thread still owns only its own invocation (no leakage, no duplicates).
        expect(final.threads!.map((thread) => thread.invocationIds)).toEqual([
            ['1'],
            ['2', '3', '4']
        ]);
        expect(transcript(final.threads![1].messages)).toEqual([
            { role: 'system', content: 'helper' },
            { role: 'user', content: 'child work' },
            { role: 'assistant', content: 'helper answer' },
            { role: 'user', content: 'continue child' },
            { role: 'assistant', content: 'helper answer' },
            { role: 'user', content: 'after restart' },
            { role: 'assistant', content: 'helper answer' }
        ]);

        reloaded.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    // R3 fallback: a document written BEFORE `invocationThreads` existed has no
    // historical map, so the roster must not invent one. It reports only what each
    // thread's own runtime record still names, and never borrows another thread's
    // ids — an unavailable original run stays unavailable rather than guessed.
    it('falls back to the live invocation slot when the persisted history is absent', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't4-threads-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore([delegationPreset()], persistence);
        const created = await store.create('lead');

        const task = await store.enqueue(created.id, 'delegate please');
        await task.settled;
        await store.waitForIdle(created.id);

        // The child resumes, so its single slot advances past the original run ('2').
        const continuation = await store.enqueue(created.id, 'continue child', undefined, undefined, 'thread-2');
        await continuation.settled;
        await store.waitForIdle(created.id);
        expect(store.get(created.id).threads!.map((thread) => thread.invocationIds)).toEqual([
            ['1'],
            ['2', '3']
        ]);
        store.dispose();

        // Simulate a document from before the map existed.
        const document = JSON.parse(fs.readFileSync(persistence.file, 'utf8')) as {
            sessions: { invocationThreads?: unknown }[];
        };
        for (const session of document.sessions) delete session.invocationThreads;
        fs.writeFileSync(persistence.file, JSON.stringify(document, null, 2), 'utf8');

        const reloaded = createStore([delegationPreset()], persistence, persistence.load()).get(created.id);
        expect(
            reloaded.threads!.map((thread) => [thread.id, thread.invocationId, thread.invocationIds])
        ).toEqual([
            ['thread-1', '1', ['1']],
            ['thread-2', '3', ['3']]
        ]);
        // The original delegated run ('2') is genuinely unavailable in this document:
        // no inference from the identical-looking transcript is attempted.
        expect(reloaded.threads![1].invocationIds).not.toContain('2');

        fs.rmSync(root, { recursive: true, force: true });
    });

    // R3 (identical siblings): TWO delegations to the SAME agent with the SAME task
    // text are still two conversations with two invocation identities. The roster's
    // historical list is what lets a client tell their cards apart — content-based
    // inference could not — and a resume of one must never touch the other.
    it('keeps identical sibling delegations on their own invocation histories', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't4-threads-'));
        const persistence = new HarnessPersistence(root);

        // ONE lead turn spawns two helper invocations with the same input text.
        const twinPreset = (): HarnessPreset => {
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
                                                    id: 'twin-a',
                                                    name: 'delegate',
                                                    arguments: JSON.stringify({
                                                        agent: 'helper',
                                                        input: 'twin task'
                                                    })
                                                },
                                                {
                                                    id: 'twin-b',
                                                    name: 'delegate',
                                                    arguments: JSON.stringify({
                                                        agent: 'helper',
                                                        input: 'twin task'
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

        const store = createStore([twinPreset()], persistence);
        const created = await store.create('lead');

        const task = await store.enqueue(created.id, 'delegate twice');
        await task.settled;
        await store.waitForIdle(created.id);

        const snapshot = store.get(created.id);
        // Two SEPARATE child conversations, same agent, same task text, same owner.
        expect(
            snapshot.threads!.map((thread) => [
                thread.id,
                thread.agent,
                thread.ownerThreadId,
                thread.invocationId,
                thread.invocationIds
            ])
        ).toEqual([
            ['thread-1', 'lead', undefined, '1', ['1']],
            ['thread-2', 'helper', 'thread-1', '2', ['2']],
            ['thread-3', 'helper', 'thread-1', '3', ['3']]
        ]);
        // Their transcripts are IDENTICAL, which is exactly why text cannot join them.
        expect(transcript(snapshot.threads![1].messages)).toEqual(
            transcript(snapshot.threads![2].messages)
        );
        // The delegating turn carries both invocation ids, one per child card.
        expect(
            snapshot.turns[0].events
                .filter((event) => event.type === 'start' && event.agent === 'helper')
                .map((event) => (event as { thread?: { id: string; input?: string } }).thread)
        ).toEqual([
            { id: '2', parentId: '1', callId: 'twin-a', input: 'twin task' },
            { id: '3', parentId: '1', callId: 'twin-b', input: 'twin task' }
        ]);

        store.dispose();

        // Restart, then resume ONE sibling. Its history grows by exactly its own new
        // run; the identical sibling's roster and transcript are untouched.
        const reloaded = createStore([twinPreset()], persistence, persistence.load());
        const restored = reloaded.get(created.id);
        expect(restored.threads!.map((thread) => thread.invocationIds)).toEqual([['1'], ['2'], ['3']]);

        const resumed = await reloaded.enqueue(created.id, 'resume b', undefined, undefined, 'thread-3');
        await resumed.settled;
        await reloaded.waitForIdle(created.id);

        const final = reloaded.get(created.id);
        expect(
            final.threads!.map((thread) => [thread.id, thread.invocationId, thread.invocationIds])
        ).toEqual([
            ['thread-1', '1', ['1']],
            ['thread-2', '2', ['2']],
            ['thread-3', '4', ['3', '4']]
        ]);
        expect(transcript(final.threads![1].messages)).toEqual([
            { role: 'system', content: 'helper' },
            { role: 'user', content: 'twin task' },
            { role: 'assistant', content: 'helper answer' }
        ]);
        expect(transcript(final.threads![2].messages)).toEqual([
            { role: 'system', content: 'helper' },
            { role: 'user', content: 'twin task' },
            { role: 'assistant', content: 'helper answer' },
            { role: 'user', content: 'resume b' },
            { role: 'assistant', content: 'helper answer' }
        ]);

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
        const created = await store.create('probe');

        const save = vi.spyOn(persistence, 'save').mockImplementation(() => {
            throw new Error('disk full');
        });

        // `enqueue` validates/persists synchronously, so the failure is a throw.
        let submitFailure: unknown;
        try {
            await store.enqueue(created.id, 'lost');
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
        const next = await store.enqueue(created.id, 'kept');
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
        const created = await store.create('probe');

        const task = await store.enqueue(created.id, 'one');
        await task.settled;
        await store.waitForIdle(created.id);

        const save = vi.spyOn(persistence, 'save').mockImplementation(() => {
            throw new Error('disk full');
        });

        let deleteFailure: unknown;
        try {
            await store.deleteThread(created.id, 'thread-1');
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
        expect((await store.deleteThread(created.id, 'thread-1')).turns).toEqual([]);
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
        const created = await store.create('probe');

        const source = await store.enqueue(created.id, 'source');
        await source.settled;

        const linked = await store.enqueue(created.id, 'connected', undefined, [
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
        expect(await store.cancelThread(created.id, source.turn.threadId!)).toEqual({
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
        const deleted = await store.deleteThread(created.id, source.turn.threadId!);
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
        const created = await store.create('probe');

        const base = await store.enqueue(created.id, 'base');
        await base.settled;

        fixture.gate('start');
        const running = await store.enqueue(created.id, 'start', undefined, undefined, 'thread-1');
        await fixture.started('start').promise;

        const steered = await store.enqueue(created.id, 'focused', undefined, [
            { turnId: base.turn.id, label: 'PE1' }
        ], 'thread-1');

        expect(steered.steered).toBe(true);
        expect(steered.steeredThreadId).toBe('thread-1');
        expect(steered.turn.id).toBe(running.turn.id);
        // Audit: the user's prompt, the bound block, and the submit's own durable identity
        // (T13) — a uuid this server minted once, which the context bar keys its segment from.
        expect(steered.turn.steers).toEqual([
            {
                id: expect.any(String),
                at: expect.any(Number),
                prompt: 'focused',
                references: [{ turnId: base.turn.id, label: 'PE1' }]
            }
        ]);
        expect((steered.turn.steers![0].id as string).length).toBeGreaterThan(8);
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
        const long = await store.enqueue(created.id, 'long', undefined, undefined, 'thread-1');
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
        const deferred = await store.enqueue(created.id, '', [attachment], undefined, 'thread-1');
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
        const created = await store.create('stubborn');

        const task = await store.enqueue(created.id, 'work');
        await fixture.started.promise;

        expect((await store.cancelThread(created.id, 'thread-1')).cancelled).toBe(true);
        // The run ignores the abort: the turn is still live.
        expect(store.get(created.id).turns[0].status).toBe('running');

        const diskBefore = fs.readFileSync(persistence.file, 'utf8');
        const memoryBefore = store.get(created.id);

        let refusal: unknown;
        try {
            await store.deleteThread(created.id, 'thread-1');
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

        const deleted = await store.deleteThread(created.id, 'thread-1');
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
    it('never reuses a deleted thread id after a restart, even with no host threads left', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't4-threads-'));
        const fixture = createFixture();
        const persistence = new HarnessPersistence(root);
        const first = createStore([fixture.preset], persistence);
        const created = await first.create('probe');

        const task = await first.enqueue(created.id, 'one');
        expect(task.turn.threadId).toBe('thread-1');
        return task.settled.then(async () => {
            await first.waitForIdle(created.id);
            expect((await first.deleteThread(created.id, 'thread-1')).threads).toBeUndefined();
            first.dispose();

            // F5: the id high-water survives an empty roster.
            const second = createStore([fixture.preset], persistence, persistence.load());
            const next = await second.enqueue(created.id, 'two');
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
    it('maps the host-thread bound to an actionable 429 before mutating', async () => {
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
        const created = await store.create('probe');

        let failure: unknown;
        try {
            await store.enqueue(created.id, 'overflow');
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
                                                name: 'delegate',
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
        const created = await store.create('lead');

        // The runtime opens the child conversation for the delegation.
        const task = await store.enqueue(created.id, 'delegate please');
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
        const parent = await store.enqueue(created.id, 'parent hold', undefined, undefined, 'thread-1');
        await startedOf('parent hold').promise;
        const child = await store.enqueue(created.id, 'child hold', undefined, undefined, 'thread-2');
        await startedOf('child hold').promise;
        const sibling = await store.enqueue(created.id, 'sibling');
        await startedOf('sibling').promise;

        expect((await store.cancelThread(created.id, 'thread-1')).cancelled).toBe(true);

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

// ---------------------------------------------------------------------------
// R18/T18: the compiled view carries the PERSISTENT conversation identity of EVERY
// section, so a delegated conversation is separately referenceable inside a turn
// ---------------------------------------------------------------------------
//
// Before this the delegated rows carried `invocationId` (a per-run id that changes on
// every resume) and nothing else, so a client could not tell that two rows belong to ONE
// conversation, could not focus/steer/delete it, and had no per-conversation bar to
// draw. These tests run the REAL runtime (scripted transport, persistent threads on) and
// read the SERVER's own compiled view, which is the wire the UI consumes.

describe('delegated conversation identity in the compiled view (R18)', () => {
    // `lead → helper`: the parent's FIRST request issues one `delegate` call, the helper
    // answers, and the parent answers once the result lands. Every later request (and
    // every later turn) answers directly, so the delegation tree is deterministic.
    const identityPreset = (): HarnessPreset => {
        let delegated = false;

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
                            stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                                const prompt = lastUser(request.messages);

                                if (prompt === 'delegate please' && !delegated) {
                                    delegated = true;

                                    yield {
                                        type: 'done',
                                        stopReason: 'tool_calls',
                                        toolCalls: [
                                            {
                                                id: 'delegate-1',
                                                name: 'delegate',
                                                arguments: JSON.stringify({ agent: 'helper', input: 'child work' })
                                            }
                                        ]
                                    };
                                    return;
                                }

                                yield { type: 'text', delta: `lead answer: ${prompt}` };
                                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                            }
                        }),
                        helper: agent({
                            model: settings.model,
                            instruction: 'helper',
                            stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                                yield { type: 'text', delta: `helper answer: ${lastUser(request.messages)}` };
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

    // One turn's compiled rows as identity tuples: `[section ordinal, conversation,
    // conversation label, invocation, parent section ordinal]`. Section ids are
    // `${turnId}:${ordinal}`, so the ordinal is the part that is stable across turns and
    // worth asserting; the label is the conversation's own display name (R8/T14).
    const rowsOf = (view: SessionView, turnId: string) =>
        view.displays[turnId].sections.map((section) => [
            section.id.slice(turnId.length + 1),
            section.threadId,
            section.threadLabel ?? section.agentLabel,
            section.invocationId,
            section.parentSectionId === undefined ? undefined : section.parentSectionId.slice(turnId.length + 1)
        ]);

    // Which row owns each context-bar segment: the per-conversation bar the UI needs.
    const barsOf = (view: SessionView, turnId: string) =>
        view.displays[turnId].sections.map((section) =>
            (section.context ?? []).map((block) => [section.id.slice(turnId.length + 1), block.kind, block.name])
        );

    // The identity half of the tuples above (conversation, run, parent), i.e. everything
    // EXCEPT the display label. The label is a separate store-owned allocation (R8/T14), so
    // each path pins its own exact value AND the label-inclusive rows compare live vs cold
    // (T20); this narrower projection is what lets a test state parity on identity without
    // re-listing every name.
    const identityOnly = (rows: (string | undefined)[][]) =>
        rows.map(([ordinal, threadId, , invocationId, parent]) => [ordinal, threadId, invocationId, parent]);

    it('gives a delegated conversation its own address in the view, live and after a restart', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't18-view-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore([identityPreset()], persistence);
        const created = await store.create('lead');

        const task = await store.enqueue(created.id, 'delegate please');
        await task.settled;
        await store.waitForIdle(created.id);

        const live = store.getView(created.id);

        // R18: the delegated row names the CONVERSATION ('thread-2'), not merely the run,
        // and stays indented under the row that spawned it (`parentSectionId`). T20: it is
        // born with its conversation's DISPLAY NAME ('HR1') on the live frame too — the
        // label join the fold reads is live, exactly like the id join, so a watcher sees the
        // same name the durable record will carry (see the parity assertions below).
        expect(rowsOf(live, task.turn.id)).toEqual([
            ['0', 'thread-1', 'LD1', '1', undefined],
            ['1', 'thread-2', 'HR1', '2', '0']
        ]);

        // R18/R9: one bar per conversation, and no segment crosses a row boundary. The
        // parent owns its submit, the delegation call and its own answer; the child owns
        // its system instructions and its answer. That is the server data a per-thread bar
        // needs — the client never has to guess which bytes belong to which conversation.
        expect(barsOf(live, task.turn.id)).toEqual([
            [
                ['0', 'system', 'instructions'],
                ['0', 'user', 'prompt'],
                ['0', 'tool', 'delegate'],
                ['0', 'assistant', 'answer']
            ],
            [
                ['1', 'system', 'instructions'],
                ['1', 'assistant', 'answer']
            ]
        ]);

        // A restart folds the persisted document cold, from the persisted invocation→
        // conversation map, and reaches the SAME identity tree (live ≡ replay, R18).
        const reloaded = createStore([identityPreset()], persistence, persistence.load());
        const restored = reloaded.getView(created.id);

        expect(rowsOf(restored, task.turn.id)).toEqual([
            ['0', 'thread-1', 'LD1', '1', undefined],
            ['1', 'thread-2', 'HR1', '2', '0']
        ]);
        expect(identityOnly(rowsOf(live, task.turn.id))).toEqual(identityOnly(rowsOf(restored, task.turn.id)));
        expect(barsOf(restored, task.turn.id)).toEqual(barsOf(live, task.turn.id));

        // T20 (closes the one live/cold difference T18 left open): the delegated row's OWN
        // display name is identical on the live frame and after a restart. The store
        // allocates it through its single canonical conversation allocator in the same step
        // it records the invocation → conversation join
        // (`noteInvocationThread` → `ensureThreadLabel`), and `displayContext` hands the fold
        // a LIVE resolving label map, so the section is born labelled and the persisted
        // document replays the exact same value. This is what makes a `#HR1` reference typed
        // while the run is still live mean the same conversation after a restart (R18).
        expect(rowsOf(live, task.turn.id)[1]).toEqual(rowsOf(restored, task.turn.id)[1]);

        // And it is the name the ROSTER publishes for that conversation, i.e. the name the
        // composer's `#` popup offers — one label sequence, one authority (R8/T14).
        expect(store.get(created.id).threads!.map((thread) => [thread.id, thread.label])).toEqual([
            ['thread-1', 'LD1'],
            ['thread-2', 'HR1']
        ]);

        store.dispose();
        reloaded.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('keeps one conversation identity across a delegated run, its focused continuation, and the next main submit', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't18-view-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore([identityPreset()], persistence);
        const created = await store.create('lead');

        // [Main]: the parent conversation delegates → its child conversation.
        const first = await store.enqueue(created.id, 'delegate please');
        await first.settled;

        // A focused submit INTO the delegated conversation: same conversation, new run.
        const second = await store.enqueue(created.id, 'continue child', undefined, undefined, 'thread-2');
        await second.settled;

        // A second submit on the MAIN conversation: the SAME main conversation, therefore
        // the same id and label, and a run id of its own ([Main] again, later).
        const third = await store.enqueue(created.id, 'main again', undefined, undefined, 'thread-1');
        await third.settled;
        await store.waitForIdle(created.id);

        const view = store.getView(created.id);

        expect(rowsOf(view, first.turn.id)).toEqual([
            ['0', 'thread-1', 'LD1', '1', undefined],
            ['1', 'thread-2', 'HR1', '2', '0']
        ]);
        // THREAD REUSE: the continuation's root row addresses the SAME conversation
        // ('thread-2'), while `invocationId` advances — a run id is never a name.
        expect(rowsOf(view, second.turn.id)).toEqual([['0', 'thread-2', 'HR1', '3', undefined]]);
        expect(rowsOf(view, third.turn.id)).toEqual([['0', 'thread-1', 'LD1', '4', undefined]]);

        // The conversation labels the composer types (`#HR1`) survive every turn in order,
        // and the historical invocation roster covers each conversation's runs.
        expect(
            store
                .get(created.id)
                .threads!.map((thread) => [thread.id, thread.label, thread.invocationIds])
        ).toEqual([
            ['thread-1', 'LD1', ['1', '4']],
            ['thread-2', 'HR1', ['2', '3']]
        ]);

        // Restart: the compiled identity of all three turns is reproduced from disk, row
        // for row (R18 live ≡ replay; the first turn's live label gap is pinned above).
        const reloaded = createStore([identityPreset()], persistence, persistence.load());
        const restored = reloaded.getView(created.id);

        // Restart: the compiled identity of all three turns is reproduced from disk, row
        // for row, LABELS INCLUDED (R18 live ≡ replay; T20 closed the delegated label, so
        // the first turn compares as a WHOLE row now, not only as its id half).
        expect(rowsOf(restored, first.turn.id)).toEqual(rowsOf(view, first.turn.id));
        expect(rowsOf(restored, second.turn.id)).toEqual(rowsOf(view, second.turn.id));
        expect(rowsOf(restored, third.turn.id)).toEqual(rowsOf(view, third.turn.id));
        expect(rowsOf(restored, first.turn.id)[1][2]).toBe('HR1');

        store.dispose();
        reloaded.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('never invents a conversation for a legacy run the roster does not name', async () => {
        // The legacy `/messages` path runs one fresh block with NO persistent conversation
        // record, so no invocation is ever mapped and the join is empty.
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't18-legacy-'));
        const store = createStore([identityPreset()], new HarnessPersistence(root));
        const created = await store.create('lead');

        await store.run(created.id, 'legacy please', () => undefined);
        await store.waitForIdle(created.id);

        const snapshot = store.get(created.id);
        const turnId = snapshot.turns[0].id;

        expect(snapshot.turns[0].threadId).toBeUndefined();

        // Nothing is minted: `threadId` is only ever ADOPTED from the store's join, so a
        // record that names no conversation keeps naming none (R18e, and the byte-compat
        // half of R20).
        expect(
            store.getView(created.id).displays[turnId].sections.map((section) => [
                section.id.slice(turnId.length + 1),
                Object.prototype.hasOwnProperty.call(section, 'threadId')
            ])
        ).toEqual([['0', false]]);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
});

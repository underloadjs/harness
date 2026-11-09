// T10: stopping/deleting a conversation while a turn is PARKED on a `#LABEL` reference.
//
// The scenario the reader hit: conversation RR4 is still streaming when IT7 submits
// `… #RR4`. IT7's turn claims its lane and then waits server-side for RR4 to settle,
// so IT7 is neither running in the harness nor queued — it is parked in
// `waitForTurnTerminal`. Two things used to go wrong from there:
//
//   1. Stop on IT7 did nothing until RR4 happened to finish (the park watched only the
//      TARGET, never this turn's abort signal), and Stop/Delete on a thread with such a
//      turn was refused with a 409;
//   2. Stopping (or deleting, or failing) RR4 killed IT7 too: the composer threw, so the
//      waiter's turn ended `error`/`cancelled` and its conversation was stopped — the
//      chaining effect the report describes.
//
// Everything runs offline against an injected scripted preset: gates park the transport,
// `armFailure` makes a released gate end in `error`, and no network is touched. Prompts,
// notes, statuses and lane state are asserted EXACTLY.
//
// Coverage map (acceptance evidence):
//   - R1: stop releases a parked waiter promptly, frees its lane, and no late run starts;
//   - R1: session-wide cancel-all releases a parked waiter too;
//   - R2: deleteThread on a parked turn succeeds (abort-then-purge);
//   - R3: a target that is stopped / deleted / errored mid-wait leaves the waiter `done`
//     with the right note, its thread un-stopped, and the session out of `error`;
//   - R4: the HTTP cancel receipt carries the store's honest result;
//   - D1 (T14): the receipt's `status` is the conversation's OWN status — proven for the
//     `agent:<name>` conversation, which has no roster row to read (or default) at all;
//   - D2 (T14): a stop the runtime REFUSES leaves every pre-set lane flag as it was, so the
//     still-running turn settles `done`, not `cancelled`;
//   - D4 (T14): a stop that lands in the SAME macrotask the target settles settles the turn
//     `cancelled` without ever dispatching a model run (no wasted provider work);
//   - gap (c) (T14): a turn that was still QUEUED when its referenced conversation was
//     deleted keeps its label (`turn.strippedReferences`, persisted without the dead turn
//     id) and composes the deleted-result note when it finally runs.

import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agent, harness } from '../harness';
import type { HarnessMessage, HarnessStreamEvent } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { createHarnessRuntime } from './runtime';
import type { HarnessRuntime } from './runtime';
import { SessionStore } from './sessions';
import { HarnessPersistence } from './persistence';
import {
    REFERENCED_RESULTS_FOOTER,
    REFERENCED_RESULTS_HEADER,
    REFERENCED_RESULTS_NO_RESULT_MARKER,
    referencedResultDeletedNote,
    referencedResultUnavailableNote
} from '../shared/agent-results';

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'super-secret-key',
    model: 'scripted/test'
};

const RUNTIME_DEFAULTS = {
    baseURL: SETTINGS.baseURL,
    model: SETTINGS.model,
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

const lastUser = (messages: readonly HarnessMessage[]): string => {
    const users = messages.filter((message) => message.role === 'user');
    const last = users[users.length - 1];
    return last === undefined ? '' : String(last.content);
};

type ProbeFixture = {
    preset: HarnessPreset;
    requests: HarnessMessage[][];
    started: (prompt: string) => Deferred;
    gate: (prompt: string) => Deferred;
    armFailure: (prompt: string) => void;
};

// One scripted agent: `gate(prompt)` parks inside the transport until the test releases
// it (so a reference can be submitted against a genuinely RUNNING target), and
// `armFailure(prompt)` makes that same release END IN ERROR. `started(prompt)` fires as
// soon as the transport sees the prompt — the only reliable proof a turn got past its
// reference wait and into a run.
const probeFixture = (): ProbeFixture => {
    const gates = new Map<string, Deferred>();
    const starts = new Map<string, Deferred>();
    const failures = new Set<string>();
    const requests: HarnessMessage[][] = [];
    let answered = 0;

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
                        // A continuation of an existing thread carries its ORIGINAL user
                        // message first, so the gate is looked up by that conversation
                        // key with a fallback to the turn's own prompt (the same routing
                        // ./threads.test.ts uses). `started`/`requests` stay keyed by the
                        // LAST user message, which is what the turn actually submitted.
                        const prompt = lastUser(request.messages);
                        const first = request.messages.find((message) => message.role === 'user');
                        const routed = typeof first?.content === 'string' ? first.content : prompt;

                        requests.push(JSON.parse(JSON.stringify(request.messages)) as HarnessMessage[]);
                        started(prompt).resolve();

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

                        if (failures.has(prompt)) {
                            yield { type: 'error', message: 'scripted provider failure' };
                            return;
                        }

                        answered += 1;
                        yield { type: 'text', delta: `answer ${answered}` };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    },
                    retry: false
                })
            },
            primary: 'probe',
            presets: false,
            report: { progress }
        })
    );

    return {
        preset,
        requests,
        started,
        gate,
        armFailure: (prompt: string) => {
            failures.add(prompt);
        }
    };
};

const createStore = (presets: HarnessPreset[], persistence?: HarnessPersistence): SessionStore =>
    new SessionStore(
        SETTINGS,
        createHarnessRegistry(presets),
        undefined,
        // The 3rd parameter is the descriptor factory, so persistence rides in `options`
        // (the same shape ../references.test.ts uses).
        persistence === undefined ? {} : { persistence }
    );

// Durable roots for the T14 gap (c) persistence assertions. Repo-root `Temp/` — the
// convention ../persistence.test.ts and ../references.test.ts use, so a crashed run leaves
// an inspectable document instead of a directory in the OS temp that nobody can find.
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TEMP_ROOT = path.join(path.resolve(PACKAGE_ROOT, '../../..'), 'Temp');
const roots: string[] = [];

const tempRoot = (label: string): string => {
    fs.mkdirSync(TEMP_ROOT, { recursive: true });

    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-stop-reference-${label}-`));
    roots.push(root);

    return root;
};

afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// Poll a condition across macrotasks (the pump and the abort unwind settle across
// several ticks), so a stalled contract fails on an OBSERVED state instead of the
// test timeout.
const waitUntil = async (condition: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
        if (condition()) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    throw new Error('condition was not met in time');
};

// The exact prompt a WAITER is run with when its target produced nothing: the same
// delimited section as a real result, with the note as the body.
const notePrompt = (prompt: string, label: string, note: string): string =>
    [
        prompt,
        '',
        REFERENCED_RESULTS_HEADER,
        `--- #${label} | ${REFERENCED_RESULTS_NO_RESULT_MARKER} ---`,
        note,
        `--- end #${label} ---`,
        REFERENCED_RESULTS_FOOTER
    ].join('\n');

// Parked = the waiter's row is `running` (its lane claimed it) while the transport has
// NEVER seen its prompt. The reference expansion happens before the run, so this is the
// precise observable signature of `waitForTurnTerminal`, not of a running model request.
const parkedSignature = (fixture: ProbeFixture, waiterPrompt: string): boolean =>
    !fixture.requests.some((messages) => lastUser(messages).startsWith(waiterPrompt));

// The park condition every test here waits on before it acts: the waiter's row is
// claimed by its lane (status 'running') while its prompt has STILL not reached the
// transport. A hang therefore fails on the observed state, which is the promptness
// proof — the same bounded-`waitUntil` convention ./threads.test.ts uses.
const awaitParked = async (store: SessionStore, id: string, fixture: ProbeFixture): Promise<void> =>
    waitUntil(() => store.get(id).turns[1].status === 'running' && parkedSignature(fixture, 'ask it7'));

const turnRows = (store: SessionStore, id: string): string[] =>
    store.get(id).turns.map((turn) => `${turn.index}:${turn.prompt}:${turn.status}`);

const threadState = (store: SessionStore, id: string, threadId: string): string => {
    const thread = store.get(id).threads?.find((candidate) => candidate.id === threadId);
    if (thread === undefined) throw new Error(`thread ${threadId} is not in the roster`);

    return thread.status;
};

describe('stop/delete against a turn parked on a referenced block', () => {
    // R1: Stop on the PARKING thread works even though that turn owns no harness run.
    it('stops a parked waiter at once, frees its lane, and never runs it late', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        // RR4: a run parked inside the transport.
        fixture.gate('hold rr4');
        const target = await store.enqueue(created.id, 'hold rr4');
        await fixture.started('hold rr4').promise;

        // IT7: a plain submit that references RR4's block, so it opens its OWN thread
        // and parks on the wait instead of queueing behind it.
        const waiter = await store.enqueue(created.id, 'ask it7', undefined, [
            { turnId: target.turn.id, label: 'PE1' }
        ]);
        const waiterThread = waiter.turn.threadId!;

        await awaitParked(store, created.id, fixture);

        // The stop, with the target STILL parked on its gate.
        const stopped = await store.cancelThread(created.id, waiterThread);
        expect(stopped.cancelled).toBe(true);

        await waitUntil(() => store.get(created.id).turns[1].status === 'cancelled');
        await waiter.settled;

        // Prompt settlement, lane released, target untouched.
        expect(turnRows(store, created.id)).toEqual(['0:hold rr4:running', '1:ask it7:cancelled']);
        expect(store.liveSession(created.id).lanes.get(waiterThread)?.active).toBeUndefined();
        expect(threadState(store, created.id, waiterThread)).toBe('stopped');
        expect(threadState(store, created.id, target.turn.threadId!)).toBe('running');

        // The target answers afterwards. The stopped waiter must NOT be revived: its
        // turn is terminal, and a stop that only un-parked it would let it run now.
        fixture.gate('hold rr4').resolve();
        await store.waitForIdle(created.id);

        expect(fixture.requests.map((messages) => lastUser(messages))).toEqual(['hold rr4']);
        expect(turnRows(store, created.id)).toEqual(['0:hold rr4:done', '1:ask it7:cancelled']);
        expect(store.liveSession(created.id).lanes.size).toBe(2);

        store.dispose();
    });

    // R1: the session-wide stop-all keeps working, and now reaches a parked waiter too
    // (it aborts every lane controller, which is what releases the park).
    it('releases a parked waiter on the session-wide cancel-all', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        fixture.gate('hold rr4');
        const target = await store.enqueue(created.id, 'hold rr4');
        await fixture.started('hold rr4').promise;

        const waiter = await store.enqueue(created.id, 'ask it7', undefined, [
            { turnId: target.turn.id, label: 'PE1' }
        ]);

        await awaitParked(store, created.id, fixture);

        expect(await store.cancel(created.id, { all: true })).toBe(true);
        await waitUntil(() => store.get(created.id).turns[1].status === 'cancelled');

        fixture.gate('hold rr4').resolve();
        await store.waitForIdle(created.id);

        // BOTH conversations stopped, the waiter never reached the model, and the
        // session's backlog is empty.
        expect(turnRows(store, created.id)).toEqual(['0:hold rr4:cancelled', '1:ask it7:cancelled']);
        expect(fixture.requests.map((messages) => lastUser(messages))).toEqual(['hold rr4']);
        expect(store.get(created.id).threads!.map((thread) => `${thread.id}:${thread.status}`)).toEqual([
            'thread-1:stopped',
            'thread-2:stopped'
        ]);

        store.dispose();
    });

    // R2: a parked turn is not "live work" that blocks a deletion — the delete stops it
    // and purges the conversation, and the target keeps running.
    it('deletes the conversation of a parked waiter (abort-then-purge)', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        fixture.gate('hold rr4');
        const target = await store.enqueue(created.id, 'hold rr4');
        await fixture.started('hold rr4').promise;

        const waiter = await store.enqueue(created.id, 'ask it7', undefined, [
            { turnId: target.turn.id, label: 'PE1' }
        ]);
        const waiterThread = waiter.turn.threadId!;

        await awaitParked(store, created.id, fixture);

        const deleted = await store.deleteThread(created.id, waiterThread);
        expect(deleted.turns.map((turn) => `${turn.index}:${turn.prompt}:${turn.status}`)).toEqual([
            '0:hold rr4:running'
        ]);
        expect(deleted.threads!.map((thread) => thread.id)).toEqual(['thread-1']);

        await waiter.settled;
        expect(store.get(created.id).turns.map((turn) => turn.prompt)).toEqual(['hold rr4']);

        // The delete only touched ITS conversation: the target is still streaming, and
        // releasing it still answers normally.
        fixture.gate('hold rr4').resolve();
        await store.waitForIdle(created.id);

        expect(turnRows(store, created.id)).toEqual(['0:hold rr4:done']);
        expect(store.liveSession(created.id).lanes.has(waiterThread)).toBe(false);

        store.dispose();
    });

    // R3 (the reported screenshot): RR4 is stopped while IT7 waits. IT7 must ANSWER,
    // saying the referenced result is gone — not be cancelled along with it.
    it('releases a parked waiter when its target is stopped, and the waiter answers done', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        fixture.gate('hold rr4');
        const target = await store.enqueue(created.id, 'hold rr4');
        await fixture.started('hold rr4').promise;

        const waiter = await store.enqueue(created.id, 'ask it7', undefined, [
            { turnId: target.turn.id, label: 'PE1' }
        ]);
        const waiterThread = waiter.turn.threadId!;

        await awaitParked(store, created.id, fixture);

        // Stop ONLY the target's conversation.
        expect((await store.cancelThread(created.id, target.turn.threadId!)).cancelled).toBe(true);
        fixture.gate('hold rr4').resolve();
        await waiter.settled;
        await store.waitForIdle(created.id);

        // The target died; the waiter lived. The chain is broken at the reference.
        expect(turnRows(store, created.id)).toEqual(['0:hold rr4:cancelled', '1:ask it7:done']);
        expect(threadState(store, created.id, target.turn.threadId!)).toBe('stopped');
        expect(threadState(store, created.id, waiterThread)).toBe('idle');

        // IT7 ran with the stop note in place of the missing result.
        const waiterRequest = fixture.requests[fixture.requests.length - 1]!;
        expect(lastUser(waiterRequest)).toBe(
            notePrompt('ask it7', 'PE1', referencedResultUnavailableNote('PE1', 'cancelled'))
        );
        expect(fixture.requests.map((messages) => lastUser(messages))).toHaveLength(2);

        // The waiter's success clears the target's cancellation banner: the session ends
        // idle, and nothing on this path leaves an error behind.
        const final = store.get(created.id);
        expect(final.status).toBe('idle');
        expect(final.lastError).toBeUndefined();

        store.dispose();
    });

    // R3: deleting the target's conversation is the same contract with the deletion note
    // — and it is the case the historical 409 refused outright.
    it('releases a parked waiter when its target is deleted, with the deleted note', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        fixture.gate('hold rr4');
        const target = await store.enqueue(created.id, 'hold rr4');
        await fixture.started('hold rr4').promise;

        const waiter = await store.enqueue(created.id, 'ask it7', undefined, [
            { turnId: target.turn.id, label: 'PE1' }
        ]);

        await awaitParked(store, created.id, fixture);

        const deleted = await store.deleteThread(created.id, target.turn.threadId!);
        expect(deleted.turns.map((turn) => turn.prompt)).toEqual(['ask it7']);

        fixture.gate('hold rr4').resolve();
        await waiter.settled;
        await store.waitForIdle(created.id);

        expect(turnRows(store, created.id)).toEqual(['1:ask it7:done']);

        // The row is gone from the record, so the note says DELETED, not "ended as
        // cancelled": the waiter is told what actually happened to its input.
        const waiterRequest = fixture.requests[fixture.requests.length - 1]!;
        expect(lastUser(waiterRequest)).toBe(notePrompt('ask it7', 'PE1', referencedResultDeletedNote('PE1')));

        const final = store.get(created.id);
        expect(final.status).toBe('idle');
        expect(final.lastError).toBeUndefined();
        expect(final.threads!.map((thread) => `${thread.id}:${thread.status}`)).toEqual(['thread-2:idle']);

        store.dispose();
    });

    // R3: a target that FAILS while the waiter is parked is reported the same way.
    it('releases a parked waiter when its target errors, with the error note', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        fixture.armFailure('hold rr4');
        fixture.gate('hold rr4');
        const target = await store.enqueue(created.id, 'hold rr4');
        await fixture.started('hold rr4').promise;

        const waiter = await store.enqueue(created.id, 'ask it7', undefined, [
            { turnId: target.turn.id, label: 'PE1' }
        ]);

        await awaitParked(store, created.id, fixture);

        // The target's provider fails after the waiter is already parked on it.
        fixture.gate('hold rr4').resolve();
        await waiter.settled;
        await store.waitForIdle(created.id);

        expect(turnRows(store, created.id)).toEqual(['0:hold rr4:error', '1:ask it7:done']);

        const waiterRequest = fixture.requests[fixture.requests.length - 1]!;
        expect(lastUser(waiterRequest)).toBe(
            notePrompt('ask it7', 'PE1', referencedResultUnavailableNote('PE1', 'error'))
        );

        // The waiter's own conversation is untouched by its target's failure.
        expect(threadState(store, created.id, waiter.turn.threadId!)).toBe('idle');

        store.dispose();
    });

    // Unchanged on purpose (design decision 4): a target that is ALREADY terminal when
    // the task is accepted is still an enqueue-time 400. Only the mid-wait death gained
    // the note, so the reader never silently queues a task against a dead block.
    it('keeps rejecting a reference to an already-terminal target at enqueue', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        fixture.gate('hold rr4');
        const target = await store.enqueue(created.id, 'hold rr4');
        await fixture.started('hold rr4').promise;

        // Park a waiter on the still-running block (the accepted mid-wait case), then
        // stop the target so its row is terminal-but-recorded.
        const first = await store.enqueue(created.id, 'ask it7', undefined, [
            { turnId: target.turn.id, label: 'PE1' }
        ]);

        await awaitParked(store, created.id, fixture);

        expect((await store.cancelThread(created.id, target.turn.threadId!)).cancelled).toBe(true);
        fixture.gate('hold rr4').resolve();
        await first.settled;
        await store.waitForIdle(created.id);

        // A fresh reference to that cancelled block is now refused BEFORE a turn exists
        // (references.test.ts:572 pins the same rule): the reader gets a 400 naming the
        // dead block instead of a task that can only answer "no result".
        await expect(
            store.enqueue(created.id, 'ask again', undefined, [{ turnId: target.turn.id, label: 'PE1' }])
        ).rejects.toThrow('Block "#PE1" cannot be referenced because it ended as cancelled.');

        expect(turnRows(store, created.id)).toEqual(['0:hold rr4:cancelled', '1:ask it7:done']);

        store.dispose();
    });

    // D2 (T14): a stop the RUNTIME refuses must change nothing. The lane flags are pre-set
    // BEFORE `harness.stopThread` (that is what classifies the abort), so when that call
    // throws no abort ever happens — and a flag left behind misclassifies the still-running
    // turn as `cancelled` through `wasCancelled()` even though it completes normally. Newly
    // reachable because `deleteThread` now calls `cancelThread` internally.
    it('restores every pre-set stop flag when the runtime refuses the stop', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        fixture.gate('hold rr4');
        const target = await store.enqueue(created.id, 'hold rr4');
        await fixture.started('hold rr4').promise;
        const threadId = target.turn.threadId!;

        const session = store.liveSession(created.id);
        const handle = session.harness as unknown as {
            stopThread: (threadId: string, reason?: string) => boolean;
        };
        const stopThread = handle.stopThread;

        handle.stopThread = () => {
            throw new Error('the runtime refused this stop');
        };

        await expect(store.cancelThread(created.id, threadId)).rejects.toThrow(
            'the runtime refused this stop'
        );

        handle.stopThread = stopThread;

        // The refusal is state-free: nothing is stopped, and the lane holds no pending stop
        // for the run's own classification to read.
        expect(session.lanes.get(threadId)?.stopRequested).toBe(false);
        expect(threadState(store, created.id, threadId)).toBe('running');

        // And the run really does complete NORMALLY afterwards — the classification the
        // reverted flag protects. With the flag left set, this row settled `cancelled`.
        fixture.gate('hold rr4').resolve();
        await target.settled;
        await store.waitForIdle(created.id);

        expect(turnRows(store, created.id)).toEqual(['0:hold rr4:done']);
        expect(threadState(store, created.id, threadId)).toBe('idle');

        store.dispose();
    });

    // D4 (T14): the same-tick stop race. `releaseTurnWaiters` runs the parked resolver
    // SYNCHRONOUSLY, and that resolver's cleanup removes the turn's abort listener — so a
    // stop that lands later in the SAME macrotask cannot reject the wait. The turn then
    // composes normally and used to dispatch a model run whose answer the cancellation threw
    // away. The wake list is the store's only seam into that tick, so this test registers its
    // own resolver BEHIND the waiter's and stops the waiter from inside the broadcast.
    it('never starts the run of a turn stopped in the same tick its target settles', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        fixture.gate('hold rr4');
        const target = await store.enqueue(created.id, 'hold rr4');
        await fixture.started('hold rr4').promise;

        const waiter = await store.enqueue(created.id, 'ask it7', undefined, [
            { turnId: target.turn.id, label: 'PE1' }
        ]);
        const waiterThread = waiter.turn.threadId!;

        await awaitParked(store, created.id, fixture);

        store.liveSession(created.id).turnWaiters.push(() => {
            // The stop fires inside the wake broadcast, after the waiter's resolver ran (it
            // sits earlier in the same spliced list): the park is RESOLVED, not rejected, and
            // `expandReferences` returns a fully composed prompt for a run that must now not
            // start.
            void store.cancelThread(created.id, waiterThread);
        });

        fixture.gate('hold rr4').resolve();
        await waiter.settled;
        await store.waitForIdle(created.id);

        // Terminal as `cancelled`, exactly the guarantee the earlier tests pin...
        expect(turnRows(store, created.id)).toEqual(['0:hold rr4:done', '1:ask it7:cancelled']);
        expect(threadState(store, created.id, waiterThread)).toBe('stopped');

        // ... but WITHOUT the wasted provider work: the transport never saw this turn's
        // prompt. Without the guard a second request lands here (the run starts, the answer
        // is discarded).
        expect(fixture.requests.map((messages) => lastUser(messages))).toEqual(['hold rr4']);

        store.dispose();
    });

    // T14 gap (c): the QUEUED waiter — its lane had not claimed it, so it is not parked in
    // the reference wait yet — used to lose its `#LABEL` SILENTLY when the target's
    // conversation was deleted. The link was stripped (correctly: no record may name a dead
    // target) and the turn simply ran bare. The label now survives as `strippedReferences`,
    // and the composer injects the same deleted-result note a mid-park deletion gets.
    it('keeps a queued waiter stripped label and composes the deleted note when it runs', async () => {
        const root = tempRoot('deleted-queued-waiter');
        const fixture = probeFixture();
        const store = createStore([fixture.preset], new HarnessPersistence(root));
        const created = await store.create('probe');

        // PE1 (`thread-1`): the target's conversation, parked inside the transport.
        fixture.gate('hold target');
        const target = await store.enqueue(created.id, 'hold target');
        await fixture.started('hold target').promise;

        // PE2 (`thread-2`): a SECOND conversation whose lane is busy, so a focused submit
        // that references PE1 cannot be steered (its target is not terminal) and is QUEUED
        // behind the blocker — the state in which a strip used to be silent.
        fixture.gate('hold blocker');
        const blocker = await store.enqueue(created.id, 'hold blocker');
        await fixture.started('hold blocker').promise;
        const waiterThread = blocker.turn.threadId!;

        const waiter = await store.enqueue(
            created.id,
            'ask queued',
            undefined,
            [{ turnId: target.turn.id, label: 'PE1' }],
            waiterThread
        );

        // The precise precondition: QUEUED (never parked in the wait, never running), with
        // the reference still bound.
        expect(waiter.turn.status).toBe('queued');
        expect(store.get(created.id).turns.map((turn) => `${turn.index}:${turn.status}`)).toEqual([
            '0:running',
            '1:running',
            '2:queued'
        ]);

        const deleted = await store.deleteThread(created.id, target.turn.threadId!);
        fixture.gate('hold target').resolve();

        expect(deleted.turns.map((turn) => `${turn.index}:${turn.prompt}`)).toEqual([
            '1:hold blocker',
            '2:ask queued'
        ]);

        // The surviving live row: no link to a row that no longer exists, and the label it
        // was submitted with kept.
        const rows = () => store.get(created.id).turns;
        const waiting = rows().find((turn) => turn.id === waiter.turn.id)!;

        expect(waiting.references).toBeUndefined();
        expect(waiting.strippedReferences).toEqual(['PE1']);

        // The durable record agrees, and names NO turn id the document no longer lists.
        const document = JSON.parse(fs.readFileSync(path.join(root, 'harness', 'state.json'), 'utf8')) as {
            sessions: { id: string; turns: { id: string; strippedReferences?: string[] }[] }[];
        };
        const persisted = document.sessions.find((candidate) => candidate.id === created.id)!;

        expect(persisted.turns.find((turn) => turn.id === waiter.turn.id)?.strippedReferences).toEqual(['PE1']);
        expect(JSON.stringify(document)).not.toContain(target.turn.id);

        // The blocker settles, the pump runs the waiter, and the note explains the missing
        // input instead of the turn answering bare.
        fixture.gate('hold blocker').resolve();
        await store.waitForIdle(created.id);

        expect(rows().map((turn) => `${turn.index}:${turn.prompt}:${turn.status}`)).toEqual([
            '1:hold blocker:done',
            '2:ask queued:done'
        ]);

        const last = fixture.requests[fixture.requests.length - 1]!;

        expect(lastUser(last)).toBe(notePrompt('ask queued', 'PE1', referencedResultDeletedNote('PE1')));

        store.dispose();
    });
});

// ---------------------------------------------------------------------------
// R4: the cancel receipt is the store's answer, not a constant
// ---------------------------------------------------------------------------

const callApi = (runtime: HarnessRuntime, method: string, pathname: string, body: unknown = {}) =>
    runtime.api({
        method,
        pathname,
        mount: '/v1/harness',
        readBody: async <T>() => body as T,
        bootstrapRoot: true
    });

const jsonOf = async <T>(result: Awaited<ReturnType<typeof callApi>>): Promise<{ status: number; body: T }> => {
    if (result.kind !== 'json') throw new Error('expected JSON');
    return { status: result.status, body: result.body as T };
};

describe('POST /threads/:id/cancel receipt honesty', () => {
    const runtimeOf = (presets: HarnessPreset[]): HarnessRuntime =>
        createHarnessRuntime({
            settings: SETTINGS,
            defaults: RUNTIME_DEFAULTS,
            store: new SessionStore(SETTINGS, createHarnessRegistry(presets)),
            loadEnvironment: false
        });

    const createSession = async (runtime: HarnessRuntime, harnessName: string): Promise<string> => {
        const result = await callApi(runtime, 'POST', '/v1/harness/sessions', { harness: harnessName });
        if (result.kind !== 'json' || result.status !== 201) throw new Error('expected a created session');

        return (result.body as { session: { id: string } }).session.id;
    };

    it('reports whether the stop actually terminated work', async () => {
        const fixture = probeFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'probe');

        const accepted = await jsonOf<{ turn_id: string; thread_id: string }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, { input: 'idle work' })
        );
        expect(accepted.status).toBe(202);
        expect(accepted.body.thread_id).toBe('thread-1');
        await runtime.store.waitForIdle(id);

        // An IDLE conversation with nothing queued: the stop landed (the thread row says
        // so) but it terminated no work, so the receipt says `cancelled: false`. Before
        // this fix the route discarded the store's answer and hardcoded `true`.
        const idle = await jsonOf<{
            cancelled: boolean;
            thread_id: string;
            session_id: string;
            status: string;
            dropped_queued_tasks: number;
        }>(await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/threads/thread-1/cancel`));

        expect(idle.status).toBe(200);
        expect(idle.body).toEqual({
            cancelled: false,
            thread_id: 'thread-1',
            session_id: id,
            status: 'stopped',
            dropped_queued_tasks: 0,
            // The thread resource's first revision: one `thread.upsert` per stop, so the
            // receipt names the very revision the roster repaint reads.
            revision: 1
        });

        // The roster agrees with the receipt — the surface the frontend repaints from.
        const roster = await jsonOf<{ items: { id: string; status: string }[] }>(
            await callApi(runtime, 'GET', `/v1/harness/sessions/${id}/threads`)
        );
        expect(roster.body.items.map((row) => `${row.id}:${row.status}`)).toEqual(['thread-1:stopped']);

        // A LIVE run plus a QUEUED continuation: both are terminated, and the receipt
        // names the dropped backlog it counted before the stop. The submit also revives
        // the stopped conversation (the documented revival path), so the live state the
        // receipt has to describe is one the store produced, not one a test hand-built.
        //
        // The second task carries an attachment on purpose: a text-only submit to a
        // RUNNING thread is STEERED (folded into the live turn, no row of its own), and
        // the receipt has to report a backlog the lane really holds. Media is the one
        // focused-submit shape that queues (./threads.test.ts:3430).
        fixture.gate('live work');
        void callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, { input: 'live work', thread_id: 'thread-1' });
        await fixture.started('live work').promise;

        const queued = await jsonOf<{ turn_id: string; status?: number }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
                input: 'queued work',
                thread_id: 'thread-1',
                attachments: [
                    {
                        id: 'image-1',
                        kind: 'image',
                        marker: '[Image 1]',
                        name: 'pixel.png',
                        mime: 'image/png',
                        size: 8,
                        data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
                    }
                ]
            })
        );
        expect(queued.status).toBe(202);

        const live = await jsonOf<{
            cancelled: boolean;
            thread_id: string;
            session_id: string;
            status: string;
            dropped_queued_tasks: number;
        }>(await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/threads/thread-1/cancel`));

        expect(live.status).toBe(200);
        expect(live.body).toEqual({
            cancelled: true,
            thread_id: 'thread-1',
            session_id: id,
            status: 'stopped',
            dropped_queued_tasks: 1,
            // The second stop of the same conversation: the thread revision moves once
            // per stop, exactly as the roster frame does.
            revision: 2
        });

        fixture.gate('live work').resolve();
        await runtime.store.waitForIdle(id);

        const rows = await jsonOf<{ items: { promptPreview: string; status: string }[] }>(
            await callApi(runtime, 'GET', `/v1/harness/sessions/${id}/turns`)
        );
        expect(rows.body.items.map((row) => `${row.promptPreview}:${row.status}`)).toEqual([
            'idle work:done',
            'live work:cancelled',
            'queued work:cancelled'
        ]);
    });

    // D1 (T14): the roster projects ONLY `origin === 'host'` rows (./sessions.ts `snapshot`),
    // so the agent's own `agent:<name>` conversation has no roster row for the route to read
    // — and the old `rosterRow?.status ?? 'stopped'` quoted a constant nothing confirmed for
    // it. The receipt now carries the conversation's own status, which is the same record the
    // roster row is projected from.
    it('reports the real status of a conversation the roster does not publish', async () => {
        const fixture = probeFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'probe');

        const receipt = await jsonOf<{
            cancelled: boolean;
            thread_id: string;
            session_id: string;
            status: string;
            dropped_queued_tasks: number;
            revision: number;
        }>(await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/threads/agent:probe/cancel`));

        expect(receipt.status).toBe(200);
        expect(receipt.body).toEqual({
            // Nothing was in flight and nothing was queued, so this stop terminated no work.
            cancelled: false,
            thread_id: 'agent:probe',
            session_id: id,
            status: 'stopped',
            dropped_queued_tasks: 0,
            // The thread resource's first revision: the stop's own `thread.upsert`.
            revision: 1
        });

        // The provenance, not just the value: the receipt equals the thread record's state,
        // and there is no roster row that this figure could have come from.
        expect(runtime.store.liveSession(id).harness.thread('agent:probe')?.status).toBe('stopped');

        const roster = await jsonOf<{ items: { id: string }[] }>(
            await callApi(runtime, 'GET', `/v1/harness/sessions/${id}/threads`)
        );

        expect(roster.body.items.map((row) => row.id)).not.toContain('agent:probe');
    });
});

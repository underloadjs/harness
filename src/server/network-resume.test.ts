// F1 (2026-11-17): a conversation whose run died of a PROVIDER NETWORK failure is resumed by the
// store itself, and the count that bounds those resumes is durable.
//
// WHAT IS ASSERTED (each item is the REQUIREMENT, not an observation — the rule is written once in
// ./sessions.ts, in the block above `INTERRUPTED_MESSAGE`):
//   - a turn that settles `error` while its conversation carries `provider-network` makes the store
//     call its OWN resume path: the SAME row is re-run in place, and an attempt that then answers
//     clears the streak;
//   - the streak rises once per failed attempt and the store stops resuming AT the ceiling (3 ⇒
//     three attempts, then the conversation rests with its recorded reason);
//   - a non-network failure (`api-error`, the classification of a throw with no provider code)
//     resumes nothing and counts nothing;
//   - the CODELESS half of the network class counts too: a failure with no `code` whose transport
//     diagnosis is `provider-transit` is `provider-network` even when the run spent ZERO retries
//     (T-W9 — no retry frame is required, so the streak rises and the row is re-run);
//   - a host CANCEL does the same (an actor, not a cause);
//   - the streak survives a restart, and a restart starts no run of its own;
//   - the ceiling resolves from the per-provider `settings.networkResumeLimit` over the deployment
//     `HARNESS_PROVIDER_NETWORK_RESUME_LIMIT`, and `0` turns auto-recovery off;
//   - every abandoned attempt leaves ONE journal `rollback` line whose events still carry the
//     terminal `error` frame — F4, the reason `provider-timeout` appeared 0 times in the operator's
//     `events.jsonl`.
//
// Everything runs offline. The scripted transport THROWS a `HarnessError` whose `code` is the
// transport's `provider-timeout`, so `stopReason: 'provider-network'` comes from the runtime's real
// classifier (../harness.ts `classifyRunStopReason`, Contract D) rather than from a hand-edited
// record. `retry: { maxRetries: 0 }` keeps exactly ONE attempt per run, which is both the reported
// defect's shape (a network death with zero retry frames) and what makes the attempt count exact.
//
// Cross-references:
//   - ./sessions.ts — `observeTerminalTurn` / `autoResumeAfterNetworkFailure` / `resumeThread` /
//     `requeueTurnInPlace` / `recordRollback` / `networkResumeLimitOf`
//   - ../harness.ts:12665 `classifyRunStopReason` — answers `provider-network` for a
//     `provider-timeout` / `provider-connection` code, retry frames or not
//   - ./config.ts `resolveNetworkResumeLimit` — the ceiling's precedence and bounds
//   - ./journal.ts `JournalRollbackRecord` — the durable witness of an abandoned attempt

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../engine/harness';
import type { HarnessStreamEvent } from '../engine/harness';
import { HarnessError } from '../engine/util/errors';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { DEFAULT_RUNTIME_CONFIGURATION } from './config';
import { HarnessPersistence } from './persistence';
import { readPersistedDocument } from './persistence-test-helpers';
import { HarnessJournal } from './journal';
import { SessionStore } from './sessions';

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'super-secret-key',
    model: 'scripted/test'
};

// The transport's own machine code for "a bound expired / the provider went silent". The runtime
// maps this code to `provider-network` whether or not a retry was spent (Contract D).
const PROVIDER_TIMEOUT = 'provider-timeout';
const NETWORK_MESSAGE = 'provider-timeout: the provider delivered 3 chunks and then went silent.';

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((finish) => {
        resolve = finish;
    });

    return { promise, resolve };
};

// The preset body shared by every scripted transport here (the store requires a full preset
// descriptor; only the `stream` differs between fixtures).
const probePreset = (
    stream: (settings: RunnerSettings, progress?: unknown) => AsyncGenerator<HarnessStreamEvent>,
    retryless = true
): HarnessPreset => ({
    name: 'probe',
    title: 'probe',
    description: 'probe scripted preset',
    requiresEndpoint: false,
    // A ONE-member card: `ranks` covers the single member, which is also the entry (routing).
    // One distinct rank means nobody sits strictly below it, so the runtime registers no
    // `delegate` row — exactly what the retired `subagents: []` stated (R15).
    entry: 'probe',
    ranks: { probe: 'A' },
    agents: ['probe'],
    tools: [],
    builtin: true,
    editable: true,
    create: (settings, progress) =>
        harness({
            agents: {
                probe: agent({
                    model: settings.model,
                    instruction: 'sys',
                    // ONE attempt per run. The core's default ladder (one request plus ten doubling
                    // waits, ../core/agent.ts) would spend twenty seconds on the deliberate failure
                    // and each retry would record its own frames — neither is the state this rule is
                    // stated against, and a network death with ZERO retry frames is the reported one.
                    ...(retryless ? { retry: { maxRetries: 0 } } : {}),
                    stream
                })
            },
            entry: 'probe',
            presets: false,
            // The store's recorder rides the harness's own progress report; a preset that omits it
            // runs without the turn ever recording its frames.
            report: { progress }
        })
});

type NetworkFixture = {
    preset: HarnessPreset;
    // How many times the scripted transport has been asked to run. The ceiling rule is stated
    // against this number, so "three attempts" is exact rather than inferred from event counts.
    attempts: () => number;
};

// A `probe` harness whose first `failures` runs die of a network-class provider failure and whose
// later runs answer. `failures: 0` always answers; a number above the attempt count never heals.
const networkFixture = (failures: number): NetworkFixture => {
    let runs = 0;

    return {
        attempts: () => runs,
        preset: probePreset(async function* (): AsyncGenerator<HarnessStreamEvent> {
            runs += 1;

            if (runs <= failures) throw new HarnessError(NETWORK_MESSAGE, { code: PROVIDER_TIMEOUT });

            yield { type: 'text', delta: 'answered' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        })
    };
};

type StoreOptions = {
    persistence?: HarnessPersistence;
    database?: ReturnType<HarnessPersistence['load']>;
    // The deployment ceiling under test; absent means the shipped default (10).
    networkResumeLimit?: number;
};

const createStore = (preset: HarnessPreset, options: StoreOptions = {}): SessionStore =>
    new SessionStore(SETTINGS, createHarnessRegistry([preset]), undefined, {
        ...(options.persistence === undefined ? {} : { persistence: options.persistence }),
        ...(options.database === undefined ? {} : { database: options.database }),
        ...(options.networkResumeLimit === undefined
            ? {}
            : {
                  runtime: {
                      ...DEFAULT_RUNTIME_CONFIGURATION,
                      networkResumeLimit: options.networkResumeLimit
                  }
              })
    });

const tempRoot = (label: string): string => fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), `f1-${label}-`));

// One submit, awaited to ITS terminal transition and then to a drained store. The auto-resume
// re-queues the same row synchronously (before the settle's own await returns), so `waitForIdle`
// covers every resumed attempt as well — which is what makes the attempt count assertable here.
const submit = async (store: SessionStore, id: string, prompt: string) => {
    const task = await store.enqueue(id, prompt);

    await task.settled;
    await store.waitForIdle(id);

    return task;
};

// The session's journal, read through the store's own reader (no path arithmetic in a test body).
const journalOf = (persistence: HarnessPersistence, id: string) => new HarnessJournal(persistence.directory, id).read();

afterEach(() => {
    vi.restoreAllMocks();
});

describe('F1: a network-failing conversation is resumed by the store, up to its ceiling', () => {
    it('re-runs the failed turn in place and clears the streak when the resumed attempt answers', async () => {
        const root = tempRoot('resume');
        const persistence = new HarnessPersistence(root);
        const fixture = networkFixture(1);
        const store = createStore(fixture.preset, { persistence });
        const id = (await store.create('probe')).id;

        const task = await submit(store, id, 'go');
        const snapshot = store.get(id);

        // ONE row, the SAME row: an in-place retry, not a second prompt the user never typed.
        expect(snapshot.turns.map((turn) => turn.id)).toEqual([task.turn.id]);
        expect(snapshot.turns[0].status).toBe('done');
        expect(snapshot.turns[0].prompt).toBe('go');
        // Two transport runs — the failed one and the one the store started itself. Without F1 this
        // number is exactly 1: the row stayed `error` until a human pressed resume.
        expect(fixture.attempts()).toBe(2);
        // A run that reached its answer reset the count, so BOTH fields are absent — the additive
        // rule that keeps an untouched session's snapshot the shape every existing client reads.
        expect(snapshot.networkFailures).toBeUndefined();
        expect(snapshot.networkFailureLimit).toBeUndefined();

        // F4 in the same breath: the abandoned attempt is still in the log, with its error frame.
        const read = journalOf(persistence, id);

        expect(read.rollbacks.length).toBe(1);
        expect(read.rollbacks[0].turnId).toBe(task.turn.id);
        // The attempt committed nothing, so the WHOLE tail was dropped — boundary -1.
        expect(read.rollbacks[0].boundary).toBe(-1);
        // The tail is every frame the abandoned attempt had written: the run's `start` and the
        // terminal provider `error`. Before F4 neither line existed in the file at all.
        expect(read.rollbacks[0].events.map((entry) => entry.event.type)).toEqual(['start', 'error']);
        // The reason is the failure's own sentence: the cause survives the resume that erases the
        // steps, which is the whole point of writing the record.
        expect(read.rollbacks[0].reason).toBe(NETWORK_MESSAGE);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('resumes up to the ceiling and then rests with its recorded reason (3 ⇒ exactly 3 attempts)', async () => {
        const root = tempRoot('ceiling');
        const persistence = new HarnessPersistence(root);
        const fixture = networkFixture(99);
        const store = createStore(fixture.preset, { persistence, networkResumeLimit: 3 });
        const id = (await store.create('probe')).id;

        const task = await submit(store, id, 'go');
        const snapshot = store.get(id);
        const threadId = task.turn.threadId as string;

        // Attempt 1 raises 1 (< 3 ⇒ resume), attempt 2 raises 2 (< 3 ⇒ resume), attempt 3 raises 3
        // (= 3 ⇒ REST). A fourth run means the ceiling is not being enforced.
        expect(fixture.attempts()).toBe(3);
        expect(snapshot.turns.length).toBe(1);
        expect(snapshot.turns[0].status).toBe('error');
        expect(snapshot.networkFailures).toEqual({ [threadId]: 3 });
        expect(snapshot.networkFailureLimit).toBe(3);

        // The roster row carries the per-conversation number (a strip renders "3/3") and the
        // conversation keeps the runtime's reason, which is why it is resting.
        const row = (snapshot.threads ?? []).find((thread) => thread.id === threadId);

        expect(row?.networkFailures).toBe(3);
        expect(row?.stopReason).toBe('provider-network');

        // Two abandoned attempts: the third failure is the row's recorded outcome, not an
        // abandonment, so it must NOT have written a rollback line.
        const read = journalOf(persistence, id);

        expect(read.rollbacks.length).toBe(2);
        expect(read.rollbacks.map((record) => record.turnId)).toEqual([task.turn.id, task.turn.id]);

        // The checkpoint-side summary carries the same evidence in bounded form, keyed by turn.
        expect(Object.keys(snapshot.turnRollbacks ?? {})).toEqual([task.turn.id]);
        expect(snapshot.turnRollbacks?.[task.turn.id].length).toBe(2);
        expect(snapshot.turnRollbacks?.[task.turn.id][0].droppedEvents).toBe(read.rollbacks[0].events.length);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('counts and resumes nothing for a non-network failure (api-error is not a network cause)', async () => {
        const root = tempRoot('api-error');
        const persistence = new HarnessPersistence(root);
        let runs = 0;

        const preset = probePreset(async function* (): AsyncGenerator<HarnessStreamEvent> {
            runs += 1;
            // No provider code on the throw, so the runtime classifies this `api-error` — the
            // spelling Contract D settles as NON-network for a live (non-restored) reason.
            throw new Error('the request body was rejected');
        });

        const store = createStore(preset, { persistence, networkResumeLimit: 3 });
        const id = (await store.create('probe')).id;

        await submit(store, id, 'go');

        expect(runs).toBe(1);
        expect(store.get(id).networkFailures).toBeUndefined();
        expect(journalOf(persistence, id).rollbacks.length).toBe(0);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('counts and resumes nothing when the host cancels the run', async () => {
        const root = tempRoot('cancel');
        const persistence = new HarnessPersistence(root);
        const release = deferred();
        // The stop has to land on a run that is IN FLIGHT. `enqueue` returns while the lane pump is
        // still starting the row, so a test that cancels immediately would drop a QUEUED turn (a
        // different path) and would never show the store refusing to resume an aborted run.
        const started = deferred();
        let runs = 0;

        const preset = probePreset(async function* (request): AsyncGenerator<HarnessStreamEvent> {
            runs += 1;
            started.resolve();
            // Abort-aware: the stop has to settle the run, not deadlock it.
            await Promise.race([
                release.promise,
                new Promise<void>((resolve, reject) => {
                    if (request.signal?.aborted === true) {
                        reject(new Error('The run was aborted.'));
                        return;
                    }

                    request.signal?.addEventListener('abort', () => reject(new Error('The run was aborted.')), {
                        once: true
                    });
                })
            ]);

            yield { type: 'text', delta: 'answered' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        });

        const store = createStore(preset, { persistence, networkResumeLimit: 3 });
        const id = (await store.create('probe')).id;
        const task = await store.enqueue(id, 'go');

        await started.promise;
        await store.cancelThread(id, task.turn.threadId as string);
        release.resolve();
        await task.settled;
        await store.waitForIdle(id);

        const snapshot = store.get(id);

        // `cancelled` is an ACTOR's stop, not evidence about the provider: nothing counts, nothing
        // re-runs, and the row keeps the status the stop wrote.
        expect(snapshot.turns[0].status).toBe('cancelled');
        expect(runs).toBe(1);
        expect(snapshot.networkFailures).toBeUndefined();
        expect(journalOf(persistence, id).rollbacks.length).toBe(0);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('keeps the streak across a restart and starts no run of its own', async () => {
        const root = tempRoot('restart');
        const persistence = new HarnessPersistence(root);
        const fixture = networkFixture(99);
        const store = createStore(fixture.preset, { persistence, networkResumeLimit: 3 });
        const id = (await store.create('probe')).id;

        const task = await submit(store, id, 'go');
        const threadId = task.turn.threadId as string;

        expect(fixture.attempts()).toBe(3);
        store.dispose();

        const restored = createStore(networkFixture(99).preset, {
            persistence,
            database: persistence.load(),
            networkResumeLimit: 3
        });
        const snapshot = restored.get(id);

        // The durable half of the fix: a restart cannot hand a dead provider a fresh set of resumes.
        expect(snapshot.networkFailures).toEqual({ [threadId]: 3 });
        expect(snapshot.networkFailureLimit).toBe(3);
        // And a restart spends none BY ITSELF: restoring an interrupted row is not an auto-resume.
        // A fixture whose first run throws would push this number to 4 the moment a restore resumed
        // anything on its own.
        expect(snapshot.turns.length).toBe(1);
        expect(snapshot.turns[0].status).toBe('error');
        expect(snapshot.turnRollbacks?.[task.turn.id].length).toBe(2);

        // The journal keeps the full tails, error frames included, for the next compaction to re-emit.
        const read = journalOf(persistence, id);

        expect(read.rollbacks.length).toBe(2);
        expect(read.rollbacks.every((record) => record.events.some((entry) => entry.event.type === 'error'))).toBe(
            true
        );

        restored.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('turns auto-recovery off when the ceiling is 0', async () => {
        const fixture = networkFixture(99);
        const store = createStore(fixture.preset, { networkResumeLimit: 0 });
        const id = (await store.create('probe')).id;

        await submit(store, id, 'go');

        // 0 means "the operator turned this off": one attempt, and nothing counted or reported.
        expect(fixture.attempts()).toBe(1);
        expect(store.get(id).networkFailures).toBeUndefined();

        store.dispose();
    });

    // T-W9 (2026-11-17): the store half of "the retry ladder is not part of the network rule".
    // A transport failure that is CODELESS — no `code` on the thrown error at all — is classed by
    // the transport's `details.errorClass` diagnosis. Before this change the classifier demanded a
    // spent retry frame as well, so a transit break on the FIRST attempt of a zero-retry run settled
    // `api-error`, which this store never counts and never resumes.
    it('counts and resumes a CODELESS provider-transit failure that spent zero retries', async () => {
        const root = tempRoot('transit');
        const persistence = new HarnessPersistence(root);
        let runs = 0;

        const preset = probePreset(async function* (): AsyncGenerator<HarnessStreamEvent> {
            runs += 1;
            // Exactly the shape the report recorded: no machine code, and the transport's own
            // diagnosis that the upstream stream died in transit (../harness.ts
            // `classifyRunStopReason` reads this through `providerDiagnosticsOf`). The preset is
            // already zero-retry (`retry: { maxRetries: 0 }`), so NO retry frame exists either.
            throw new HarnessError('Upstream stream terminated', {
                details: { errorClass: 'provider-transit', url: SETTINGS.baseURL }
            });
        });

        const store = createStore(preset, { persistence, networkResumeLimit: 2 });
        const id = (await store.create('probe')).id;

        const task = await submit(store, id, 'go');
        const snapshot = store.get(id);
        const threadId = task.turn.threadId as string;

        // `provider-network`, so the streak rises and the store re-runs the row up to the ceiling:
        // attempt 1 raises 1 (< 2 ⇒ resume), attempt 2 raises 2 (= 2 ⇒ rest).
        expect(runs).toBe(2);
        expect(snapshot.turns.length).toBe(1);
        expect(snapshot.turns[0].status).toBe('error');
        expect(snapshot.networkFailures).toEqual({ [threadId]: 2 });
        expect(snapshot.networkFailureLimit).toBe(2);

        const row = (snapshot.threads ?? []).find((thread) => thread.id === threadId);

        expect(row?.stopReason).toBe('provider-network');
        // And the abandoned attempt is durable, with its terminal frame: the reason the operator
        // can see WHICH attempt died of what.
        expect(journalOf(persistence, id).rollbacks.length).toBe(1);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('prefers the per-provider setting over the deployment ceiling, and carries it through a restart', async () => {
        const root = tempRoot('setting');
        const persistence = new HarnessPersistence(root);
        const fixture = networkFixture(99);
        // The provider field is a RUNNER setting, so it arrives through the store's defaults (the
        // same path a created session's model/baseURL take) and is merged by `mergeSettings`.
        const store = new SessionStore(
            { ...SETTINGS, networkResumeLimit: 2 },
            createHarnessRegistry([fixture.preset]),
            undefined,
            { persistence, runtime: { ...DEFAULT_RUNTIME_CONFIGURATION, networkResumeLimit: 7 } }
        );
        const id = (await store.create('probe')).id;

        const task = await submit(store, id, 'go');
        const threadId = task.turn.threadId as string;

        // 2, not 7: the explicit provider value wins, and the streak stops exactly there.
        expect(fixture.attempts()).toBe(2);
        expect(store.get(id).networkFailures).toEqual({ [threadId]: 2 });
        expect(store.get(id).networkFailureLimit).toBe(2);

        // Durable in the SESSION shard, not only in memory: the next process resolves the same
        // ceiling instead of silently reverting to the environment's.
        const persisted = readPersistedDocument(root).sessions.find((session) => session.id === id);

        expect(persisted?.settings?.networkResumeLimit).toBe(2);

        store.dispose();

        const reopened = createStore(networkFixture(99).preset, {
            persistence,
            database: persistence.load(),
            networkResumeLimit: 7
        });

        expect(reopened.get(id).networkFailureLimit).toBe(2);
        expect(reopened.get(id).networkFailures).toEqual({ [threadId]: 2 });

        reopened.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
});

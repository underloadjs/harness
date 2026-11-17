// F4 (2026-11-17): an in-place resume must not destroy journal or attempt evidence.
//
// WHAT IS ASSERTED (requirements, from the defect report and from the rule block in ./sessions.ts):
//   - the cold rewrite of the per-step log keeps the event records of EVERY turn of EVERY
//     conversation, not only the turn being re-run (the old rewrite filtered to that turn, so every
//     OTHER conversation's steps vanished from the file and a journal rebuild could no longer see
//     them);
//   - the abandoned attempt's tail — INCLUDING its terminal `error` frame — stays RECOVERABLE, as a
//     journal `rollback` line beside the live records; the live turn row still does not carry those
//     steps (that is what the rollback means, and re-folding them would put the ghost steps back);
//   - a restart re-folds the resumed row to exactly its live history (no ghost steps) and keeps both
//     durable copies of the evidence (the journal's full tail, the shard's bounded summary), so a
//     SECOND resume of a different turn adds evidence instead of erasing the first one;
//   - the persist-failure rollback takes the record back with the events it described, so the file
//     never states a truncation that did not happen;
//   - `reset()` starts a new conversation and drops the abandoned-attempt evidence with it (the
//     journal is truncated, and a rewrite that still carried the lines would publish evidence for
//     turn rows that no longer exist).
//
// Cross-references:
//   - ./sessions.ts — `compactJournal` / `journalEventRecordsOf` / `recordRollback` /
//     `undoRollback` / `requeueTurnInPlace` / `mergeJournal`
//   - ./journal.ts — `JournalRollbackRecord`, the rewrite rules, and the `createdAt` stamp
//   - ./network-resume.test.ts — the same records produced by the AUTO-resume path (F1); here the
//     evidence is produced by a host-initiated resume, which is the route both share

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../harness';
// T-W8: every recorded `thread` payload now carries the minting process's epoch
// (../core/agent-limits.ts `HARNESS_PROCESS_EPOCH`, stamped at the run-identity mints in
// ../harness.ts). These assertions are WHOLE payloads, so the key has to be named; the
// value is exact because every frame here was recorded IN THIS PROCESS, and vitest gives
// one module registry per test file — one epoch for the whole file.
import { HARNESS_PROCESS_EPOCH } from '../core/agent-limits';
import type { HarnessStreamEvent } from '../harness';
import { HarnessError } from '../util/errors';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { DEFAULT_RUNTIME_CONFIGURATION } from './config';
import { HarnessPersistence } from './persistence';
import { HarnessJournal } from './journal';
import { SessionStore } from './sessions';

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'super-secret-key',
    model: 'scripted/test'
};

const PROVIDER_TIMEOUT = 'provider-timeout';
const NETWORK_MESSAGE = 'provider-timeout: the stream died in transit.';

const tempRoot = (label: string): string => fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), `f4-${label}-`));

type Fixture = {
    preset: HarnessPreset;
    // Arm a ONE-SHOT network failure for the next run only. Everything else answers, so each test
    // produces exactly the number of abandoned attempts it states.
    failNext: () => void;
    attempts: () => number;
};

const answerFixture = (): Fixture => {
    let armed = false;
    let runs = 0;

    return {
        attempts: () => runs,
        failNext: () => {
            armed = true;
        },
        preset: {
            name: 'probe',
            title: 'probe',
            description: 'probe scripted preset',
            requiresEndpoint: false,
            primary: 'probe',
            subagents: [],
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
                            retry: { maxRetries: 0 },
                            stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
                                runs += 1;

                                if (armed) {
                                    armed = false;

                                    throw new HarnessError(NETWORK_MESSAGE, { code: PROVIDER_TIMEOUT });
                                }

                                yield { type: 'text', delta: 'answered' };
                                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                            }
                        })
                    },
                    primary: 'probe',
                    presets: false,
                    report: { progress }
                })
        }
    };
};

const createStore = (
    preset: HarnessPreset,
    persistence?: HarnessPersistence,
    database?: ReturnType<HarnessPersistence['load']>,
    // F1 is OFF in the tests whose route under test is a HOST resume: a network-class failure would
    // otherwise be auto-resumed before the host could, and the row would never sit in the state the
    // resume door requires (./sessions.ts `networkResumeLimitOf`, `0` = auto-recovery off).
    networkResumeLimit?: number
): SessionStore =>
    new SessionStore(SETTINGS, createHarnessRegistry([preset]), undefined, {
        ...(persistence === undefined ? {} : { persistence }),
        ...(database === undefined ? {} : { database }),
        ...(networkResumeLimit === undefined
            ? {}
            : { runtime: { ...DEFAULT_RUNTIME_CONFIGURATION, networkResumeLimit } })
    });

const journalOf = (persistence: HarnessPersistence, id: string) => new HarnessJournal(persistence.directory, id).read();

// One submit, awaited to its terminal transition and then to a drained store (the auto-resume
// re-queues the same row synchronously, so the drain covers the resumed attempt too).
const submit = async (store: SessionStore, id: string, prompt: string, threadId?: string) => {
    const task = await store.enqueue(id, prompt, undefined, undefined, threadId);

    await task.settled;
    await store.waitForIdle(id);

    return task;
};

// The event records the file holds for one turn, as (index, frame type) pairs — the exact shape a
// rebuild replays, so an equality here IS the claim "this file still describes this turn".
const fileRecordsOf = (read: ReturnType<typeof journalOf>, turnId: string): { index: number; type: string }[] =>
    read.events
        .filter((record) => record.turnId === turnId)
        .map((record) => ({ index: record.index, type: record.event.type }));

afterEach(() => {
    vi.restoreAllMocks();
});

describe("F4: a resume keeps every turn's journal records and the abandoned attempt's evidence", () => {
    it("keeps a SIBLING conversation's event records through a resume of another conversation", async () => {
        const root = tempRoot('sibling');
        const persistence = new HarnessPersistence(root);
        const fixture = answerFixture();
        const store = createStore(fixture.preset, persistence);
        const id = (await store.create('probe')).id;

        // A healthy conversation, with real recorded steps.
        const kept = await submit(store, id, 'keep-me');

        // A second conversation that dies of a network failure and is resumed: the resume is what
        // rewrites the log, and the rewrite used to keep only THIS turn.
        fixture.failNext();

        const failed = await submit(store, id, 'boom');
        const snapshot = store.get(id);
        const read = journalOf(persistence, id);

        // The live row of the SIBLING, and the file's records for it: identical, in order. Before
        // the fix this list was EMPTY — the rewrite dropped every turn but the one being re-run.
        const liveRow = (snapshot.turns ?? []).find((turn) => turn.id === kept.turn.id) as {
            events: { type: string }[];
        };

        expect(fileRecordsOf(read, kept.turn.id)).toEqual(
            liveRow.events.map((event, index) => ({ index, type: event.type }))
        );
        // Non-trivially so: the sibling really did record frames.
        expect(liveRow.events.length).toBeGreaterThan(1);

        // And the resumed turn's own records match its LIVE (rolled-back) row, which is the other
        // half of the rule: the file agrees with the record, not with the attempt that was dropped.
        const resumedRow = (snapshot.turns ?? []).find((turn) => turn.id === failed.turn.id) as {
            events: { type: string }[];
        };

        expect(fileRecordsOf(read, failed.turn.id)).toEqual(
            resumedRow.events.map((event, index) => ({ index, type: event.type }))
        );

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('keeps the abandoned attempt recoverable while the live row stays rolled back', async () => {
        const root = tempRoot('evidence');
        const persistence = new HarnessPersistence(root);
        const fixture = answerFixture();
        const store = createStore(fixture.preset, persistence);
        const id = (await store.create('probe')).id;

        fixture.failNext();

        const task = await submit(store, id, 'boom');
        const snapshot = store.get(id);
        const read = journalOf(persistence, id);

        // The live row: the resumed attempt only. The provider error is NOT in the fold, which is
        // what makes the resumed answer render instead of a settled error row.
        const liveRow = snapshot.turns.find((turn) => turn.id === task.turn.id) as { events: { type: string }[] };

        expect(liveRow.events.some((event) => event.type === 'error')).toBe(false);

        // The file: the tail lives beside the live records, as one rollback line for this turn.
        expect(read.rollbacks.length).toBe(1);

        const rollback = read.rollbacks[0];

        expect(rollback.turnId).toBe(task.turn.id);
        expect(rollback.boundary).toBe(-1);
        expect(rollback.reason).toBe(NETWORK_MESSAGE);
        expect(rollback.events.map((entry) => entry.index)).toEqual([0, 1]);
        // The frames themselves, in order: what the attempt streamed, then the terminal `error` the
        // resume erases from the live row. The frame is asserted WHOLE (the recorder stamps `agent`
        // and the runtime `thread` join onto it) — and that error frame is the byte the operator's
        // `events.jsonl` never contained before this fix.
        expect(rollback.events.map((entry) => entry.event.type)).toEqual(['start', 'error']);
        expect(rollback.events[rollback.events.length - 1].event).toEqual({
            type: 'error',
            agent: 'probe',
            // T-W8: the recorder stamps the run identity WHOLE, and since T-W8 that identity
            // carries the minting process's epoch (`HarnessThread.epoch`, minted in
            // ../core/agent-limits.ts). Exact because the abandoned attempt ran in this process;
            // vitest gives one module registry per test file, so the file has one epoch.
            thread: { id: '1', epoch: HARNESS_PROCESS_EPOCH },
            error: { message: NETWORK_MESSAGE, code: PROVIDER_TIMEOUT }
        });

        // The checkpoint's bounded summary carries the same terminal frame, keyed by turn — the copy
        // that survives worker mode, where the rewrite channel carries event records only.
        const summary = snapshot.turnRollbacks?.[task.turn.id];

        expect(summary?.length).toBe(1);
        expect(summary?.[0].boundary).toBe(-1);
        expect(summary?.[0].droppedEvents).toBe(rollback.events.length);
        expect(summary?.[0].reason).toBe(NETWORK_MESSAGE);
        expect((summary?.[0].errors ?? []).map((event) => event.type)).toEqual(['error']);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('survives a restart, and a SECOND resume adds evidence instead of erasing the first', async () => {
        const root = tempRoot('restart');
        const persistence = new HarnessPersistence(root);
        const fixture = answerFixture();
        const store = createStore(fixture.preset, persistence);
        const id = (await store.create('probe')).id;

        fixture.failNext();

        const first = await submit(store, id, 'one');

        store.dispose();

        const restored = createStore(fixture.preset, persistence, persistence.load());
        const afterRestart = restored.get(id);
        const readAfterRestart = journalOf(persistence, id);

        // A restart folds the resumed row to exactly what the live record held: no ghost `error`
        // step came back from the rollback line.
        const row = afterRestart.turns.find((turn) => turn.id === first.turn.id) as { events: { type: string }[] };

        expect(row.events.some((event) => event.type === 'error')).toBe(false);
        // Both copies came back: the journal still holds the full tail, and the shard still names it.
        expect(readAfterRestart.rollbacks.length).toBe(1);
        expect(afterRestart.turnRollbacks?.[first.turn.id]?.length).toBe(1);

        // A second, unrelated failure — the compaction it triggers used to rewrite the file from the
        // live rows alone, which erased the FIRST attempt's evidence. The restore re-adopted it, so
        // both lines are still there.
        fixture.failNext();

        const second = await submit(restored, id, 'two');
        const read = journalOf(persistence, id);

        expect(read.rollbacks.map((record) => record.turnId)).toEqual([first.turn.id, second.turn.id]);
        expect(restored.get(id).turnRollbacks?.[first.turn.id]?.length).toBe(1);
        expect(restored.get(id).turnRollbacks?.[second.turn.id]?.length).toBe(1);

        // The header stamp survives every rewrite (a rebuild keeps the log's identity).
        const header = readAfterRestart.header as { createdAt: number } | undefined;
        const headerNow = read.header as { createdAt: number } | undefined;

        expect(headerNow?.createdAt).toBe(header?.createdAt);

        restored.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('leaves no evidence behind when the conversation is reset', async () => {
        const root = tempRoot('reset');
        const persistence = new HarnessPersistence(root);
        const fixture = answerFixture();
        const store = createStore(fixture.preset, persistence);
        const id = (await store.create('probe')).id;

        fixture.failNext();
        await submit(store, id, 'boom');

        expect(journalOf(persistence, id).rollbacks.length).toBe(1);

        await store.reset(id);

        const read = journalOf(persistence, id);
        const snapshot = store.get(id);

        // The log restarts, and the abandoned-attempt records restart with it: a rewrite that still
        // carried them would publish evidence for turn rows the record no longer holds.
        expect(read.empty).toBe(true);
        expect(read.rollbacks.length).toBe(0);
        expect(snapshot.turnRollbacks).toBeUndefined();
        expect(snapshot.networkFailures).toBeUndefined();

        // And the NEXT compaction (the next resume in the new conversation) cannot resurrect them.
        fixture.failNext();
        await submit(store, id, 'again');

        expect(journalOf(persistence, id).rollbacks.length).toBe(1);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('rolls the record back with the events when the resumed row cannot be saved', async () => {
        const root = tempRoot('rollback');
        const persistence = new HarnessPersistence(root);
        const fixture = answerFixture();
        const store = createStore(fixture.preset, persistence, undefined, 0);
        const id = (await store.create('probe')).id;

        fixture.failNext();

        const task = await submit(store, id, 'boom');

        // A resume whose CHECKPOINT fails must put everything back: the events, and the rollback
        // record that described their removal. The route is refused by the failing persist, so the
        // store's state (row + log) has to be the interrupted one again.
        const save = vi.spyOn(persistence, 'save').mockImplementation(() => {
            throw new Error('disk full');
        });

        await expect(store.resumeThread(id, task.turn.threadId as string)).rejects.toThrow('disk full');

        save.mockRestore();

        const read = journalOf(persistence, id);
        const snapshot = store.get(id);
        const row = snapshot.turns.find((turn) => turn.id === task.turn.id) as { events: { type: string }[] };

        // No rollback record survived the refused resume...
        expect(read.rollbacks.length).toBe(0);
        expect(snapshot.turnRollbacks).toBeUndefined();
        // ...and the file still matches the live row, which after a refused rollback is the
        // interrupted row again (its frames back, no truncation claimed).
        expect(fileRecordsOf(read, task.turn.id)).toEqual(
            row.events.map((event, index) => ({ index, type: event.type }))
        );

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
});

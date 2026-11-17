// T-W14 (2026-11-17): the F1 streak must not outlive the conversation it counts.
//
// THE GAP. `clearNetworkStreak` (./sessions.ts:10594) documents THREE clearing events — "a run that
// reached its answer, a deletion, or a reset" — but only two were wired: `observeTerminalTurn` on
// `done` (./sessions.ts:10612) and `reset()` (./sessions.ts:12161). NO deletion path called it, and
// the restore filter (./sessions.ts:4449-4453) claimed in its comment to drop "a conversation
// deleted since" while its predicate only tested `streak > 0 && id.trim()`. So:
//
//   (1) ORPHANED STATE: a retired (`inactive: true`) conversation kept its entry in
//       `Session.networkFailures` forever, in memory AND in the session shard, surviving restarts;
//   (2) AN INHERITED STREAK: a conversation REVIVED after a delete (the revival door is a submit on
//       the retained id — ./sessions.ts `reactivateThreadRow`, pinned by ./deletion-evidence.test.ts
//       "revive clears the marker") came back with the retired conversation's number already on it,
//       so its first fresh failure could land AT the ceiling and be refused an auto-resume it had
//       not earned.
//
// WHAT THESE TESTS PIN (the documented contract, not an observation):
//   1. the delete: the streak is gone from the receipt, from the store, and from the SHARD the
//      delete itself writes (the deletion is durable, so a crash after it cannot restore the
//      orphan);
//   2. the revival: a revived conversation earns its OWN streak — with ceiling 3 and a provider that
//      always drops the connection it gets its three attempts, exactly like a never-deleted one;
//   3. restore pruning: a streak naming a conversation the document no longer names is dropped, and
//      a streak naming a conversation the document records as RETIRED is dropped — while a live
//      conversation's streak comes back verbatim (the F1 durability rule is untouched).
//
// Cross-references:
//   - ./sessions.ts — `clearNetworkStreak` / `raiseNetworkStreak` / `observeTerminalTurn` /
//     `markDeletedThread` (the mark) / `reactivateThreadRow` (the revive) / `restoreSession`'s
//     streak restore + prune
//   - ./network-resume.test.ts — the F1 rule itself (ceiling, in-place retry, durability)
//   - ./deletion-evidence.test.ts — the soft-delete mark, its reload evidence, and the revive door
//   - ./persistence.ts — `HarnessSessionRecord.networkFailures` (:375) and `readCounterMap` (:1469)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessStreamEvent } from '../harness';
import { HarnessError } from '../util/errors';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { DEFAULT_RUNTIME_CONFIGURATION } from './config';
import { HarnessPersistence } from './persistence';
import { readPersistedDocument, readPersistedSession, writePersistedDocument } from './persistence-test-helpers';
import { SessionStore } from './sessions';

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'super-secret-key',
    model: 'scripted/test'
};

// The transport's own machine code for "the provider went silent"; the runtime's real classifier
// answers `provider-network` for it (Contract D), which is the ONLY way a streak rises. Same spelling
// as ./network-resume.test.ts, so both suites exercise one vocabulary.
const PROVIDER_TIMEOUT = 'provider-timeout';
const NETWORK_MESSAGE = 'provider-timeout: the provider delivered 3 chunks and then went silent.';

// One attempt per run: the core's default retry ladder would spend its own waits inside a single
// run, and the attempt count is the figure every assertion here is stated against.
const presetOf = (stream: () => AsyncGenerator<HarnessStreamEvent>): HarnessPreset => ({
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
                    stream
                })
            },
            primary: 'probe',
            presets: false,
            report: { progress }
        })
});

// A provider that NEVER answers: every run dies of a network-class failure, so the conversation
// climbs to its ceiling and rests there. `attempts()` is the store's own transport count.
const droppingFixture = (): { preset: HarnessPreset; attempts: () => number } => {
    let runs = 0;

    return {
        attempts: () => runs,
        preset: presetOf(async function* (): AsyncGenerator<HarnessStreamEvent> {
            runs += 1;

            throw new HarnessError(NETWORK_MESSAGE, { code: PROVIDER_TIMEOUT });
        })
    };
};

// A provider that ALWAYS answers — for the restore-pruning pins, where the fact under test is what
// the DOCUMENT carries about a streak, not what a failing run does with it.
const answeringPreset = (): HarnessPreset =>
    presetOf(async function* (): AsyncGenerator<HarnessStreamEvent> {
        yield { type: 'text', delta: 'answer' };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    });

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

// Scratch goes under the repo's own Temp (root AGENTS.md); `TEMP` is the variable these suites read.
const tempRoot = (label: string): string =>
    fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), `f1-retire-${label}-`));

const submit = async (store: SessionStore, id: string, prompt: string, threadId?: string) => {
    const task = await store.enqueue(id, prompt, undefined, undefined, threadId);

    await task.settled;
    await store.waitForIdle(id);

    return task;
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe('F1 streak lifetime: a deletion retires the number, a revival starts from zero', () => {
    it('clears the retired conversation’s streak in the receipt, the store and the written shard', async () => {
        const root = tempRoot('delete');
        const persistence = new HarnessPersistence(root);
        const fixture = droppingFixture();
        const store = createStore(fixture.preset, { persistence, networkResumeLimit: 3 });
        const id = (await store.create('probe')).id;

        const task = await submit(store, id, 'go');
        const threadId = task.turn.threadId as string;

        // The starting state the deletion has to undo: the conversation is at its ceiling and is
        // resting there (three attempts, streak 3), exactly as ./network-resume.test.ts pins.
        expect(fixture.attempts()).toBe(3);
        expect(store.get(id).networkFailures).toEqual({ [threadId]: 3 });

        const deleted = await store.deleteThread(id, threadId);

        // THE CONTRACT ("a deletion" clears): the receipt, the live store, and the roster all read a
        // clean number. The field is ADDITIVE, so "clean" means the key is ABSENT, not zero.
        expect(deleted.networkFailures).toBeUndefined();
        expect(store.get(id).networkFailures).toBeUndefined();
        // The retired conversation keeps its reason and its `inactive` marker; it does NOT keep the
        // number that decided how often it was auto-resumed.
        expect(deleted.inactiveThreads).toEqual([threadId]);

        // DURABLE in the write the deletion itself makes — not merely in memory until the next
        // checkpoint. An entry left here is the orphan that survives every restart.
        expect(readPersistedSession(root, id).networkFailures).toBeUndefined();

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('gives a revived conversation its own streak instead of the retired one', async () => {
        const root = tempRoot('revive');
        const persistence = new HarnessPersistence(root);
        const fixture = droppingFixture();
        const store = createStore(fixture.preset, { persistence, networkResumeLimit: 3 });
        const id = (await store.create('probe')).id;

        const first = await submit(store, id, 'go');
        const threadId = first.turn.threadId as string;

        expect(fixture.attempts()).toBe(3);
        expect(store.get(id).networkFailures).toEqual({ [threadId]: 3 });

        await store.deleteThread(id, threadId);
        expect(store.get(id).inactiveThreads).toEqual([threadId]);

        // THE REVIVAL: a submit on the retained id (the door ./deletion-evidence.test.ts pins for
        // "revive clears the marker"). The conversation is a live conversation again, so F1 applies
        // to it again — and the number it starts from must be its OWN, not the retired one's.
        const second = await submit(store, id, 'again', threadId);

        expect(second.turn.threadId).toBe(threadId);
        // A revived conversation gets its full allowance: three attempts for the new turn on top of
        // the three the old one spent. The pre-fix store inherited the ceiling it had already
        // reached, so the revived run failed ONCE, was refused the resume (`streak >= limit`), and
        // this number was 4 — an auto-resume withheld from a conversation that had earned it.
        expect(fixture.attempts()).toBe(6);
        // And the number it now carries was earned by these three attempts, not inherited.
        expect(store.get(id).networkFailures).toEqual({ [threadId]: 3 });
        // The revival lifted the marker: the conversation is back in every roster.
        expect(store.get(id).inactiveThreads).toBeUndefined();

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('drops a restored streak whose conversation the document no longer names', async () => {
        const root = tempRoot('prune-unknown');
        const persistence = new HarnessPersistence(root);
        const store = createStore(answeringPreset(), { persistence });
        const id = (await store.create('probe')).id;

        await submit(store, id, 'go');
        store.dispose();

        // A hand-edited (or pre-fix) document: one streak on a conversation that EXISTS, one on an id
        // the document never heard of. The restore filter's own comment promises the second one is
        // "dropped rather than keeping a streak nobody can address"; the map must agree.
        const document = readPersistedDocument(root);

        document.sessions[0].networkFailures = { 'thread-1': 2, 'thread-9': 5 };
        writePersistedDocument(root, document);

        const restored = createStore(answeringPreset(), { persistence, database: persistence.load() });

        // The live conversation's streak comes back EXACTLY as committed (the F1 durability rule,
        // unchanged), and the entry nobody can address is gone rather than growing forever.
        expect(restored.get(id).networkFailures).toEqual({ 'thread-1': 2 });

        restored.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('drops the restored streak of a conversation the document records as retired', async () => {
        const root = tempRoot('prune-retired');
        const persistence = new HarnessPersistence(root);
        const store = createStore(answeringPreset(), { persistence });
        const id = (await store.create('probe')).id;

        await submit(store, id, 'go');
        store.dispose();

        // A document written BEFORE the deletion cleared the number: the row carries the retirement
        // marker and the streak side by side. The rule is one rule, so the reload cannot honour only
        // one of the two halves.
        const document = readPersistedDocument(root);

        document.sessions[0].core.threads[0].inactive = true;
        document.sessions[0].core.threads[0].inactiveAt = 1_700_000_000_000;
        document.sessions[0].networkFailures = { 'thread-1': 4 };
        writePersistedDocument(root, document);

        const restored = createStore(answeringPreset(), { persistence, database: persistence.load() });
        const snapshot = restored.get(id);

        // The retirement evidence itself is untouched (./deletion-evidence.test.ts pins that field),
        // only the orphaned number goes with the conversation's active life.
        expect(snapshot.inactiveThreads).toEqual(['thread-1']);
        expect(snapshot.networkFailures).toBeUndefined();

        // Pruning here is not a one-tick filter: the restored store writes the pruned map back, so
        // the map cannot creep upward across a session's life no matter how many restarts it sees.
        restored.dispose();
        expect(readPersistedSession(root, id).networkFailures).toBeUndefined();

        fs.rmSync(root, { recursive: true, force: true });
    });
});

// T14 (R8-R10): ONE canonical label sequence for legacy `/messages` blocks and
// persistent conversations.
//
// WHAT IS ASSERTED (each number below is the REQUIREMENT, not an observation):
//   - a legacy `/messages` turn is its own one-block conversation and takes the
//     next ordinal of the agent code, so three legacy turns then one task give
//     RR1/RR2/RR3 and the conversation RR4 (never a second RR1);
//   - a task first, then a legacy run, cannot duplicate `#RR1`: the legacy block
//     continues the sequence (RR2) and a typed `#RR1` still targets the task;
//   - a restored document whose label MAP is missing recovers the surviving turn's
//     recorded label (RR3 stays RR3) and the next conversation is RR4;
//   - a failed persistence write rolls the label bookkeeping back, so the ordinal a
//     rejected submit minted is re-used by the next accepted submit (RR2, not RR3);
//   - deletion retires a name across a restart (RR1 deleted => next is RR3);
//   - a repeated conversation re-uses its label and burns no ordinal;
//   - a nested child conversation draws from the SAME sequence as its root, so two
//     agents that share a two-letter code get LD1 and LD2, never LD1 twice.
//
// Everything runs offline against scripted presets: no provider, no network, no
// real clock dependency (nothing here asserts a timestamp).
//
// Cross-references:
//   - ./sessions.ts — ensureThreadLabel / adoptPersistedLabels / labelSeedOf /
//     reserveLegacyBlockLabel / enqueue rollback
//   - ../shared/agent-results.ts — the block projection and its label reservation

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessStreamEvent } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { HarnessPersistence } from './persistence';
import { SessionError, SessionStore } from './sessions';
import type { SessionSnapshot } from './protocol';
import { listAgentResultBlocks } from '../shared/agent-results';

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'super-secret-key',
    model: 'scripted/test'
};

// Agent id -> label code is first+last ASCII letter, so `researcher` is RR and
// `lead`/`loaded` are both LD (the same-code collision case).
const researcherPreset = (): HarnessPreset => ({
    name: 'researcher',
    title: 'researcher',
    description: 'researcher scripted preset',
    requiresEndpoint: false,
    primary: 'researcher',
    subagents: [],
    agents: ['researcher'],
    tools: [],
    builtin: true,
    editable: true,
    create: (settings, progress) =>
        harness({
            agents: {
                researcher: agent({
                    model: settings.model,
                    instruction: 'sys',
                    stream: async function* () {
                        yield { type: 'text', delta: 'ok' };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            primary: 'researcher',
            presets: false,
            report: { progress }
        })
});

// `lead` delegates ONCE to `loaded`; both ids reduce to the code LD, so a correct
// unified sequence must give the child conversation LD2 (not a second LD1).
const teamPreset = (): HarnessPreset => ({
    name: 'team',
    title: 'team',
    description: 'team scripted preset',
    requiresEndpoint: false,
    primary: 'lead',
    subagents: ['loaded'],
    agents: ['lead', 'loaded'],
    tools: [],
    builtin: true,
    editable: true,
    create: (settings, progress) =>
        harness({
            agents: {
                lead: agent({
                    model: settings.model,
                    instruction: 'Delegate once, then answer.',
                    stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                        const last = request.messages[request.messages.length - 1];

                        // The delegated result came back: answer and finish.
                        if (last !== undefined && last.role === 'tool' && last.name === 'agentDelegate') {
                            yield { type: 'text', delta: 'done by child' };
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
                                    arguments: '{"agent":"loaded","input":"find it"}'
                                }
                            ]
                        };
                    }
                }),
                loaded: agent({
                    model: settings.model,
                    instruction: 'Answer the lead.',
                    stream: async function* () {
                        yield { type: 'text', delta: 'child answer' };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            primary: 'lead',
            subagents: ['loaded'],
            presets: false,
            report: { progress }
        })
});

// One store per test; `persistence` makes every structural mutation durable so the
// reload cases exercise the real document.
const createStore = (
    preset: HarnessPreset,
    persistence?: HarnessPersistence,
    database?: ReturnType<HarnessPersistence['load']>
): SessionStore =>
    // The store's provider defaults are the scripted settings (the key is never
    // persisted; the durable record keeps baseURL + model only).
    new SessionStore(SETTINGS, createHarnessRegistry([preset]), undefined, {
        ...(persistence === undefined ? {} : { persistence }),
        ...(database === undefined ? {} : { database })
    });

afterEach(() => {
    vi.restoreAllMocks();
});

// The legacy `/messages` path: response-owned run, one fresh block per turn.
const runLegacy = async (store: SessionStore, id: string, prompt: string): Promise<void> => {
    await store.run(id, prompt, async () => {});
    await store.waitForIdle(id);
};

// One queued task (optionally continuing an existing conversation) awaited to its
// terminal state.
const submit = async (
    store: SessionStore,
    id: string,
    prompt: string,
    threadId?: string
): Promise<{ label: string | undefined; threadId: string | undefined; turnId: string }> => {
    const task = store.enqueue(id, prompt, undefined, undefined, threadId);
    await task.settled;
    await store.waitForIdle(id);

    return {
        label: task.turn.threadLabel,
        threadId: task.turn.threadId,
        turnId: task.turn.id
    };
};

// Block labels exactly as a client renders them: conversation-scoped numbering
// seeded from each turn's recorded start counters.
const blockLabels = (snapshot: SessionSnapshot): string[] =>
    listAgentResultBlocks(
        snapshot.turns.map((turn) => ({
            ...turn,
            ...(snapshot.labelSeeds?.[turn.id] === undefined
                ? {}
                : { labels: snapshot.labelSeeds[turn.id] })
        }))
    ).map((block) => block.label);

// Roster display names in creation order (the host conversations only).
const rosterLabels = (snapshot: SessionSnapshot): string[] =>
    (snapshot.threads ?? []).map((thread) => thread.label);

describe('one canonical conversation/legacy label sequence', () => {
    it('numbers three legacy turns RR1-RR3 and the next conversation RR4', async () => {
        const store = createStore(researcherPreset());
        const id = store.create('researcher').id;

        // A legacy turn is a fresh one-block conversation: it consumes one ordinal
        // of the primary agent's code even though no thread record exists.
        await runLegacy(store, id, 'old-1');
        await runLegacy(store, id, 'old-2');
        await runLegacy(store, id, 'old-3');

        const task = await submit(store, id, 'new-conversation');
        const snapshot = store.get(id);

        // The conversation continues AFTER the blocks the transcript shows; before
        // the fix the two counters were disjoint and this was a second RR1.
        expect(task.label).toBe('RR4');
        expect(rosterLabels(snapshot)).toEqual(['RR4']);
        expect(blockLabels(snapshot)).toEqual(['RR1', 'RR2', 'RR3', 'RR4']);
        // The reserved ordinal is durable evidence, not a per-read guess.
        expect(snapshot.labelHighWater).toEqual({ RR: 4 });

        store.dispose();
    });

    it('continues the sequence after a task so a legacy run cannot duplicate #RR1', async () => {
        const store = createStore(researcherPreset());
        const id = store.create('researcher').id;

        const first = await submit(store, id, 'thread-first');
        await runLegacy(store, id, 'legacy-after');

        expect(first.label).toBe('RR1');

        // The legacy block is the SECOND number of the code, so `#RR1` still names
        // exactly one block — the task's root.
        const after = store.get(id);
        expect(blockLabels(after)).toEqual(['RR1', 'RR2']);

        const referenced = store.enqueue(id, 'use #RR1');
        expect(referenced.turn.references).toEqual([{ turnId: first.turnId, label: 'RR1' }]);
        await referenced.settled;
        await store.waitForIdle(id);

        store.dispose();
    });

    it('adopts a surviving turn label when the label maps are missing (RR3 stays RR3)', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't14-labels-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore(researcherPreset(), persistence);
        const id = store.create('researcher').id;

        const one = await submit(store, id, 'one');
        const two = await submit(store, id, 'two');
        const three = await submit(store, id, 'three');

        expect([one.label, two.label, three.label]).toEqual(['RR1', 'RR2', 'RR3']);

        // Retire RR1/RR2 so only RR3 survives.
        store.deleteThread(id, one.threadId as string);
        store.deleteThread(id, two.threadId as string);
        store.dispose();

        // Simulate a partial write: the per-thread label map AND its high-water are
        // gone while the surviving turn still records the label the user saw.
        const document = JSON.parse(fs.readFileSync(persistence.file, 'utf8')) as {
            sessions: Record<string, unknown>[];
        };
        for (const session of document.sessions) {
            delete session.threadLabels;
            delete session.threadLabelHighWater;
        }
        fs.writeFileSync(persistence.file, JSON.stringify(document, null, 2), 'utf8');

        const restored = createStore(researcherPreset(), persistence, persistence.load());
        const snapshot = restored.get(id);

        // The recorded turn label is the strongest evidence: it is adopted BEFORE
        // anything is allocated, so the survivor keeps RR3 instead of being renamed
        // RR1 (and the counter is already at 3).
        expect(snapshot.turns.map((turn) => turn.threadLabel)).toEqual(['RR3']);
        expect(rosterLabels(snapshot)).toEqual(['RR3']);
        expect(snapshot.labelHighWater).toEqual({ RR: 3 });
        // Seeds survive the deletion, so the surviving block keeps its number.
        expect(snapshot.labelSeeds).toEqual({
            [three.turnId]: { RR: 2 }
        });

        const next = await submit(restored, id, 'after-restore');
        expect(next.label).toBe('RR4');

        restored.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('rolls the label bookkeeping back when the accepted submit cannot be saved', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't14-rollback-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore(researcherPreset(), persistence);
        const id = store.create('researcher').id;

        const kept = await submit(store, id, 'kept');
        expect(kept.label).toBe('RR1');

        // A rejected submit is never published: the 500 leaves no turn and must not
        // retire the ordinal it minted on the way.
        const failing = vi.spyOn(persistence, 'save').mockImplementation(() => {
            throw new Error('boom');
        });

        expect(() => store.enqueue(id, 'lost')).toThrow(SessionError);

        const afterFailure = store.get(id);
        expect(afterFailure.turns.map((turn) => turn.prompt)).toEqual(['kept']);
        expect(afterFailure.labelHighWater).toEqual({ RR: 1 });
        expect(rosterLabels(afterFailure)).toEqual(['RR1']);

        failing.mockRestore();

        // The expected number is RR2 — with a leaked counter this was RR3.
        const retry = await submit(store, id, 'retry');
        expect(retry.label).toBe('RR2');
        expect(rosterLabels(store.get(id))).toEqual(['RR1', 'RR2']);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('never re-mints a deleted conversation name, even after a restart', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't14-restart-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore(researcherPreset(), persistence);
        const id = store.create('researcher').id;

        const first = await submit(store, id, 'e1');
        const second = await submit(store, id, 'e2');
        expect([first.label, second.label]).toEqual(['RR1', 'RR2']);

        store.deleteThread(id, first.threadId as string);
        store.dispose();

        const restored = createStore(researcherPreset(), persistence, persistence.load());
        const next = await submit(restored, id, 'e3');

        // RR1 was retired by the deletion, so the new conversation is RR3.
        expect(next.label).toBe('RR3');
        expect(rosterLabels(restored.get(id))).toEqual(['RR2', 'RR3']);

        restored.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('re-uses a conversation label and burns no ordinal on a continuation', async () => {
        const store = createStore(researcherPreset());
        const id = store.create('researcher').id;

        const first = await submit(store, id, 'f1');
        const again = await submit(store, id, 'f2', first.threadId);
        const next = await submit(store, id, 'f3');

        expect(first.label).toBe('RR1');
        expect(again.threadId).toBe(first.threadId);
        // The continuation repeats the conversation's name...
        expect(again.label).toBe('RR1');
        // ...and the NEXT conversation therefore takes RR2 (not RR3).
        expect(next.label).toBe('RR2');
        expect(rosterLabels(store.get(id))).toEqual(['RR1', 'RR2']);

        store.dispose();
    });

    it('numbers a nested child conversation from the root conversation sequence', async () => {
        const store = createStore(teamPreset());
        const id = store.create('team').id;

        await submit(store, id, 'delegate please');
        const snapshot = store.get(id);

        // `lead` and `loaded` share the LD code: the child conversation must take
        // the NEXT ordinal (LD2), which is the case that used to mint LD1 twice
        // because an explicit root label did not reserve its number.
        expect(rosterLabels(snapshot)).toEqual(['LD1', 'LD2']);
        expect((snapshot.threads ?? []).map((thread) => thread.agent)).toEqual(['lead', 'loaded']);
        expect(blockLabels(snapshot)).toEqual(['LD1', 'LD2']);
        expect(snapshot.turns.map((turn) => turn.threadLabel)).toEqual(['LD1']);

        store.dispose();
    });
});

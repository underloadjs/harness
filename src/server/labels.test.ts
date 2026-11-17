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
// v2 layout readers/writers (./persistence-test-helpers.ts): the label maps live in the session
// shard, so the "partial write" tamper below edits THAT file.
import { readPersistedDocument, writePersistedDocument } from './persistence-test-helpers';
import { SessionError, SessionStore } from './sessions';
import type { SessionSnapshot } from './protocol';
// R19: the invocation-RUN key rule (./protocol.ts), so a fixture states the join's key with the
// SAME helper the recorder writes with instead of re-typing the separator, and the epoch half is
// the real per-process value the runtime stamped (../core/agent-limits `HARNESS_PROCESS_EPOCH`).
import { invocationIdOfRunKey, invocationRunKeyOf } from './protocol';
import { HARNESS_PROCESS_EPOCH } from '../core/agent-limits';
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
                        if (last !== undefined && last.role === 'tool' && last.name === 'delegate') {
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
                                    name: 'delegate',
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

// F8 fixture: primary `instruct` (code IT) delegates ONCE to `workspace` (code WE). Two distinct
// codes are the point — a mint that picks the wrong agent is then visible as the wrong LETTERS,
// which is exactly how the live dump read `IT5`…`IT13` for `workspace`/`reviewer`/`researcher`
// conversations (`instruct` merely being the session's primary agent).
const instructPreset = (): HarnessPreset => ({
    name: 'instruct',
    title: 'instruct',
    description: 'instruct scripted preset',
    requiresEndpoint: false,
    primary: 'instruct',
    subagents: ['workspace'],
    agents: ['instruct', 'workspace'],
    tools: [],
    builtin: true,
    editable: true,
    create: (settings, progress) =>
        harness({
            agents: {
                instruct: agent({
                    model: settings.model,
                    instruction: 'Delegate once, then answer.',
                    stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                        const last = request.messages[request.messages.length - 1];

                        if (last !== undefined && last.role === 'tool' && last.name === 'delegate') {
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
                                    name: 'delegate',
                                    arguments: '{"agent":"workspace","input":"find it"}'
                                }
                            ]
                        };
                    }
                }),
                workspace: agent({
                    model: settings.model,
                    instruction: 'Answer the instruct.',
                    stream: async function* () {
                        yield { type: 'text', delta: 'child answer' };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            primary: 'instruct',
            subagents: ['workspace'],
            presets: false,
            report: { progress }
        })
});

// The loose view of the persisted shard a tamper needs: the committed roster rows carry the label
// and the soft-delete mark, and the writer's type does not advertise those keys as optional.
type TamperedThread = { id: string; agent?: string; label?: string; inactive?: boolean };
const tamperedThreads = (record: { core?: unknown }): TamperedThread[] =>
    ((record.core ?? {}) as { threads?: TamperedThread[] }).threads ?? [];

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
    const task = await store.enqueue(id, prompt, undefined, undefined, threadId);
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
        const id = (await store.create('researcher')).id;

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
        const id = (await store.create('researcher')).id;

        const first = await submit(store, id, 'thread-first');
        await runLegacy(store, id, 'legacy-after');

        expect(first.label).toBe('RR1');

        // The legacy block is the SECOND number of the code, so `#RR1` still names
        // exactly one block — the task's root.
        const after = store.get(id);
        expect(blockLabels(after)).toEqual(['RR1', 'RR2']);

        const referenced = await store.enqueue(id, 'use #RR1');
        expect(referenced.turn.references).toEqual([{ turnId: first.turnId, label: 'RR1' }]);
        await referenced.settled;
        await store.waitForIdle(id);

        store.dispose();
    });

    it('adopts every retained turn label when the label maps are missing (RR1-RR3 keep their numbers)', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't14-labels-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore(researcherPreset(), persistence);
        const id = (await store.create('researcher')).id;

        const one = await submit(store, id, 'one');
        const two = await submit(store, id, 'two');
        const three = await submit(store, id, 'three');

        expect([one.label, two.label, three.label]).toEqual(['RR1', 'RR2', 'RR3']);

        // Mark RR1/RR2's conversations deleted. IT19 retains their turn rows, so a restore has
        // to adopt all three labels, not just the one the old purge left behind.
        await store.deleteThread(id, one.threadId as string);
        await store.deleteThread(id, two.threadId as string);
        store.dispose();

        // Simulate a partial write: the per-thread label map AND its high-water are
        // gone while the surviving turn still records the label the user saw. v2 keeps those
        // maps in the SESSION shard (`sessions/<id>/session.json`), so the tamper goes there —
        // same missing-fields state, one file deeper.
        const document = readPersistedDocument(root);
        for (const session of document.sessions) {
            delete session.threadLabels;
            delete session.threadLabelHighWater;
        }
        writePersistedDocument(root, document);

        const restored = createStore(researcherPreset(), persistence, persistence.load());
        const snapshot = restored.get(id);

        // The recorded turn labels are the strongest evidence: they are adopted BEFORE anything
        // is allocated, so every retained row keeps the number the user saw — RR1 and RR2 are not
        // re-minted and the survivor is not renamed RR1 (and the counter is already at 3).
        expect(snapshot.turns.map((turn) => turn.threadLabel)).toEqual(['RR1', 'RR2', 'RR3']);
        expect(rosterLabels(snapshot)).toEqual(['RR3']);
        expect(snapshot.labelHighWater).toEqual({ RR: 3 });
        // Every RETAINED row keeps its seed, so a resumed conversation keeps its number: RR2's
        // block still seeds RR2 and RR3's still seeds RR3. RR1's seed is `{RR: 0}` — an empty
        // value, so it is pruned from the map by the pre-existing additive rule, not by the
        // deletion.
        expect(snapshot.labelSeeds).toEqual({
            [two.turnId]: { RR: 1 },
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
        const id = (await store.create('researcher')).id;

        const kept = await submit(store, id, 'kept');
        expect(kept.label).toBe('RR1');

        // A rejected submit is never published: the 500 leaves no turn and must not
        // retire the ordinal it minted on the way.
        const failing = vi.spyOn(persistence, 'save').mockImplementation(() => {
            throw new Error('boom');
        });

        await expect(store.enqueue(id, 'lost')).rejects.toThrow(SessionError);

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

    // F8 (2026-11-17) — THE ROLLBACK IS A DELTA, NOT A MAP REPLACE.
    //
    // `enqueue` mints this submit's conversation name, then awaits the write that makes its ACCEPT
    // durable (./sessions.ts: `await this.persistOrThrow()`, and its catch is what runs the
    // rollback). That await is a WINDOW, and sibling lanes mint inside it — a delegated child's
    // name is allocated by the recorder mid-run, on another thread of the same session. The old
    // rollback replayed the pre-submit copies of all three label maps, so it took back a name a
    // still-live sibling was wearing (and rewound the counter to where this submit found it).
    //
    // THE TEST injects the sibling's delta at the exact moment the window is open — inside the save
    // that fails — because that IS the state the interleaving produces: the same three maps, holding
    // a name this submit never touched. It is a simulation of the lane interleave, not a second
    // real lane, and the assertion is the requirement either way: a rejected submit releases ONLY
    // its own (thread → label) pair, and compare-lowers a counter only while it still sits where
    // this submit left it (./sessions.ts `undoSubmitLabels`).
    it('releases only its own ordinal when a sibling lane minted inside the persist window', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 'f8-delta-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore(researcherPreset(), persistence);
        const id = (await store.create('researcher')).id;

        const kept = await submit(store, id, 'kept');

        expect(kept.label).toBe('RR1');

        // The write that must fail, and the sibling's mint that lands while it is in flight. This
        // submit already took RR2 at its own accept (before the await), so the sibling's child
        // conversation is RR3 — a name this submit never touched, on a thread of its own.
        const original = persistence.save.bind(persistence);
        let armed = true;

        const failing = vi.spyOn(persistence, 'save').mockImplementation((database) => {
            if (!armed) return original(database);

            armed = false;

            const live = store.liveSession(id);

            live.threadLabels.set('agent:workspace', 'RR3');
            live.threadLabelHighWater.set('RR', 3);
            live.labelHighWater.set('RR', 3);

            throw new Error('boom');
        });

        await expect(store.enqueue(id, 'lost')).rejects.toThrow(SessionError);

        failing.mockRestore();

        const live = store.liveSession(id);

        // The sibling's name survives its own conversation: the rollback deleted only this submit's
        // pair. A map replace would have taken RR3 back with it.
        expect(live.threadLabels.get('agent:workspace')).toBe('RR3');
        // This submit's conversation is gone from the allocation record (its 500 never published).
        expect([...live.threadLabels.keys()]).toEqual(['thread-1', 'agent:workspace']);
        // The counter stays where the SIBLING left it (the CAS refuses to lower a figure this submit
        // did not write), so the durable counters and the live names agree. A map replace rewound it
        // to the pre-submit 1, which is what let the next submit re-take a live name.
        expect(store.get(id).labelHighWater).toEqual({ RR: 3 });
        expect(store.get(id).turns.map((turn) => turn.prompt)).toEqual(['kept']);

        // And the sequence continues from the sibling, not from the rolled-back figure: the retired
        // RR2 is passed over (a counter that high is a fact about the sequence, not about this
        // submit), so the next accepted conversation is RR4.
        const retry = await submit(store, id, 'retry');

        expect(retry.label).toBe('RR4');

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('never re-mints a deleted conversation name, even after a restart', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 't14-restart-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore(researcherPreset(), persistence);
        const id = (await store.create('researcher')).id;

        const first = await submit(store, id, 'e1');
        const second = await submit(store, id, 'e2');
        expect([first.label, second.label]).toEqual(['RR1', 'RR2']);

        await store.deleteThread(id, first.threadId as string);
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
        const id = (await store.create('researcher')).id;

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

    // F8 (2026-11-17) — THE CODE MUST COME FROM THE CONVERSATION. The live dump this fix was
    // written against (`Temp/orch-plan/report.md`) held 17 conversations whose `threadLabels`
    // entries read `IT1`…`IT13` while the SAME conversations' retained runtime rows carried
    // `WE*`/`RH*`/`GL*`/`RR*` — the agents were `workspace`, `reviewer`, `gitlab`, `researcher`,
    // and `instruct` was only the session's PRIMARY agent. Two consequences, both pinned here:
    //   - a hint-less mint named the wrong agent, because the fallback was the primary;
    //   - the two label stores then handed the SAME name to different conversations (`WE6` twice:
    //     `threadLabels` and `core.threads[].label` disagreed, and the counter sat behind an
    //     ordinal a live row already held).
    // The rule now: live record → caller's hint → the conversation's OWN durable evidence (the
    // retained row / a label a turn still shows / an archived run) → the preset's primary LAST
    // (./sessions.ts `ensureThreadLabel`, `threadAgentContextOf`, `threadLabelHolder`).
    it('numbers a nested child conversation from the root conversation sequence', async () => {
        const store = createStore(teamPreset());
        const id = (await store.create('team')).id;

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

    // F8 (2026-11-17) — A HINT-LESS MINT MUST NAME THE CONVERSATION'S OWN AGENT.
    //
    // The live dump (`Temp/orch-plan/report.md` §1-§2) is the defect: `session.threadLabels` read
    // `IT1`…`IT13` for 17 conversations whose RETAINED rows named agents `workspace`, `reviewer`,
    // `research` and `general` (`core.threads[].label` read `WE*`/`RR*`/`RH*`/`GL*` for the same
    // ids). `instruct` was only the session's PRIMARY agent: `ensureThreadLabel` fell back to
    // `session.preset.primary` whenever `harness.thread()` did not name the conversation — which is
    // the ordinary state of a soft-deleted row (R2 retains it) and of a document whose join is the
    // only evidence left. The wrong code is not cosmetic: it is written into the map, onto the turn
    // records, and into every `#` reference typed afterwards.
    it('mints a hint-less conversation label from its own agent, not the primary', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 'f8-agent-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore(instructPreset(), persistence);
        const id = (await store.create('instruct')).id;

        const delegated = await submit(store, id, 'delegate please');

        // The live path HAS the hint (the recorder knows the member it delegated to), so the child
        // conversation is `WE1` from its first step and the primary stays `IT1`.
        const before = store.get(id);

        expect(delegated.label).toBe('IT1');
        expect(rosterLabels(before)).toEqual(['IT1', 'WE1']);
        expect((before.threads ?? []).map((thread) => thread.agent)).toEqual(['instruct', 'workspace']);

        const child = (before.threads ?? []).find((thread) => thread.agent === 'workspace')?.id as string;

        // Rebuild the dump's shape: the child is SOFT-DELETED (`inactive: true`, so the live handle
        // and the roster do not name it) AND the session-side map has lost its entry AND the row's
        // mirrored name is gone. What survives is exactly what the operator's document still carried:
        // the retained row's `agent`, and the invocation → conversation join.
        const document = readPersistedDocument(root);

        for (const record of document.sessions) {
            if (record.threadLabels !== undefined) delete record.threadLabels[child];

            for (const thread of tamperedThreads(record)) {
                if (thread.id !== child) continue;

                delete thread.label;
                thread.inactive = true;
            }
        }

        writePersistedDocument(root, document);

        const restored = createStore(instructPreset(), persistence, persistence.load());

        // THE MINT: the display fold joins the child's recorded invocation onto its conversation, and
        // that conversation has no recorded name, so `ensureThreadLabel` runs with NO hint at all
        // (./sessions.ts `invocationThreadLabels` → `threadAgentContextOf`).
        restored.getView(id);

        // The WE sequence advanced and the IT sequence did not. Before the fix the fallback was the
        // preset's primary agent, so this figure read `{ IT: 2, WE: 1 }` and the conversation was
        // renamed `IT2` — the dump's `IT5`…`IT13`.
        expect(restored.get(id).labelHighWater).toEqual({ IT: 1, WE: 2 });

        // And the name the mint came to is what the revived conversation is listed under: `WE2`
        // (`WE1` stays retired behind the monotonic high-water), never `IT2`.
        const revived = await submit(restored, id, 'still yours', child);

        expect(revived.label).toBe('WE2');
        expect(rosterLabels(restored.get(id))).toEqual(['IT1', 'WE2']);

        restored.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    // F8 (2026-11-17) — A MINT MAY NOT HAND OUT A NAME SOMEONE ALREADY WEARS.
    //
    // `nextConversationOrdinal` reads the two high-water maps, but a name can be LIVE without its
    // ordinal ever reaching them: the dump's `thread-4`/`thread-5` rows carried `RH1`/`GL1` while the
    // session's maps held `IT5`/`IT6` and its counters had never seen `RH`/`GL` at all, and
    // `adoptPersistedLabels` DROPS a map entry when two conversations claim one name — after which
    // the loser is re-minted from a counter that never saw the winner. That is how `WE6` appeared
    // twice in one roster (`Temp/orch-plan/report.md` §1: `WE6`/`WE7`/`WE8`/`RR2` each occur exactly
    // twice in `session.json`, once per label store).
    it('skips an ordinal a different conversation already shows, even from the other label store', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 'f8-holder-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore(researcherPreset(), persistence);
        const id = (await store.create('researcher')).id;

        const one = await submit(store, id, 'h1');
        const two = await submit(store, id, 'h2');

        expect([one.label, two.label]).toEqual(['RR1', 'RR2']);

        // Retire the SECOND conversation the way the host does: a soft delete keeps the row (with
        // its label) and hides it, which is also the state the dump shows for `thread-11` (`RR1` on
        // the retained row, `IT12` in the map) and `thread-15/16/17`.
        await store.deleteThread(id, two.threadId as string);

        // THE DIVERGENCE, rebuilt as a partial write. Four things at once:
        //   - the SESSION map no longer holds `RR2`, and both counters are wound back to 1;
        //   - the retired conversation's TURN ROWS are gone (reachable the same way the dump was
        //     produced: the conversation's turns were pruned, then the conversation deleted), so no
        //     allocation pass can re-mint its name;
        //   - the invocation → conversation join no longer names it either, which is the half that
        //     actually matters: the display fold mints through that join (./sessions.ts
        //     `invocationThreadLabels`), so while the join survives the fold re-adopts `RR2` and the
        //     counter is already past the collision before any mint is at risk;
        //   - the RETAINED runtime row still carries `label: 'RR2'` — the store's own mirror
        //     (./sessions.ts `mirrorThreadLabel`), and the address `threadRead`/`#RR2` still resolve.
        // Nothing adopts that name back, so the allocator believes `RR2` is free while a name the
        // harness can still answer to is wearing it. That is the dump's shape: `WE6` named twice in
        // one document, once per label store, the counter behind both.
        const document = readPersistedDocument(root);

        for (const record of document.sessions) {
            record.threadLabels = { [one.threadId as string]: 'RR1' };
            record.threadLabelHighWater = { RR: 1 };
            record.labelHighWater = { RR: 1 };
            record.turns = record.turns.filter((turn: { threadId?: string }) => turn.threadId !== two.threadId);

            const join = record.invocationThreads as Record<string, string> | undefined;

            if (join !== undefined) {
                record.invocationThreads = Object.fromEntries(
                    Object.entries(join).filter(([, threadId]) => threadId !== two.threadId)
                );
            }

            // The archived per-run records are the THIRD piece of evidence the fold can re-adopt a
            // name from (./sessions.ts `threadAgentContextOf` reads them, and the runtime re-binds
            // the invocation join from them), so the divergence drops this conversation's runs too.
            // What survives is ONE fact: the retained row still wears `RR2`.
            const core = record.core as Record<string, any> | undefined;

            if (core !== undefined && Array.isArray(core.agentResults)) {
                core.agentResults = core.agentResults.filter(
                    (result: { threadId?: string }) => result.threadId !== two.threadId
                );
            }
        }

        writePersistedDocument(root, document);

        const restored = createStore(researcherPreset(), persistence, persistence.load());

        // The tampered state must really be the divergent one, or the test would prove nothing: the
        // retired conversation's row still names RR2, while no counter, no map entry, no turn row and
        // no invocation join mentions it.
        const held = tamperedThreads(readPersistedDocument(root).sessions[0] ?? {});

        expect(held.map((thread) => `${thread.id}:${thread.label}:${thread.inactive === true}`)).toEqual([
            `${one.threadId}:RR1:false`,
            `${two.threadId}:RR2:true`
        ]);
        expect(restored.get(id).labelHighWater).toEqual({ RR: 1 });

        const three = await submit(restored, id, 'h3');

        // `RR2` is held by ANOTHER conversation (its own row says so), so the new conversation takes
        // RR3 and BOTH counters are raised past the collision. Without the holder check this minted
        // `RR2` a second time — the duplicate the dump shows for `WE6`/`WE7`/`WE8`/`RR2` — and the
        // turn row this submit publishes would show a name a live conversation already wears.
        expect(three.label).toBe('RR3');
        expect(restored.get(id).labelHighWater).toEqual({ RR: 3 });
        // No two conversations answer to the same name — the union of BOTH stores is what a client
        // renders, so that is the set uniqueness has to hold against.
        expect(rosterLabels(restored.get(id))).toEqual(['RR1', 'RR3']);

        restored.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
});

// R19 (2026-11-17) — THE invocation→conversation join is scoped to the invocation RUN.
//
// WHY THESE TESTS EXIST (measured, not theorised): the operator's recorded turn
// (Temp/orch-plan/session.json, turn 319cfc1c) shows an invocation id used by TWO conversations,
// because `runSequence` is per-process (../harness.ts:8268, and restore only RAISES it at :8153 /
// `reserveIdentity`:8235). Its persisted join read `invocationThreads["15"] = "thread-14"` — the
// pre-restart `workspace` child, whose display name is `WE6` — while the turn's own record said
// its ROOT run was invocation `15`, which after the restart is the MAIN conversation `IT4`. The
// label pass resolved both facts to ONE bare-id key and let the turn's fact WIN, so the dead
// child's row rendered `IT4`.
//
// What is pinned, in the store's real machinery (document tamper + restore + the store's own
// display projector), so no fixture can drift from what a client actually reads:
//   J1 — the entry written from a run's OWN `start` frame outranks a turn's epoch-less statement
//        about the same id; a delegated conversation keeps its name;
//   J2 — a join written before the scoping (BARE id keys, the only keys a pre-change document
//        has) still resolves every conversation it ever named, including for a row that carries an
//        epoch — the fallback is what makes this change additive rather than a migration;
//   J3 — a run-keyed entry belonging to ANOTHER process cannot move a row that is not its run,
//        and the roster's `invocationIds` stay BARE invocation ids on the wire
//        (./protocol.ts `invocationIdOfRunKey`; a client joins them onto `TurnSection.invocationId`).
describe('the invocation join is scoped to one invocation run', () => {
    // One row's identity exactly as the display surface publishes it. Absent fields stay absent.
    const sectionsOf = (store: SessionStore, id: string, turnId: string) =>
        (store.turnProjector(id, turnId)?.display().sections ?? []).map((section) => ({
            agent: section.agent,
            agentLabel: section.agentLabel,
            ...(section.invocationId === undefined ? {} : { invocationId: section.invocationId }),
            ...(section.threadId === undefined ? {} : { threadId: section.threadId })
        }));

    // The roster's invocation join, as a client sees it: `[label, latest id, every id, origin id]`.
    const rosterJoinOf = (snapshot: SessionSnapshot) =>
        (snapshot.threads ?? []).map((thread) => [
            thread.label,
            thread.invocationId,
            thread.invocationIds,
            thread.originInvocationId
        ]);

    it('keeps a delegated conversation named for the id its own run reported (J1)', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 'r19-join-authority-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore(instructPreset(), persistence);
        const id = (await store.create('instruct')).id;

        // One process: the main conversation runs as invocation `1` (`IT1`) and delegates to a
        // `workspace` conversation that runs as invocation `2` (`WE1`).
        const task = await submit(store, id, 'delegate please');
        const written = store.get(id);

        expect(task.label).toBe('IT1');
        expect(rosterLabels(written)).toEqual(['IT1', 'WE1']);

        const turnId = task.turnId;

        store.dispose();

        // THE RESTART, rebuilt the way the operator's document states it: the turn's OWN (resumed)
        // run reported invocation id `2`, the id the CHILD run had written into the join first.
        // `turnInvocations` is the only place a turn names its root run, and it carries no epoch,
        // so before the fix this line is what renamed the child conversation.
        const document = readPersistedDocument(root) as {
            sessions: { turnInvocations?: Record<string, string> }[];
        };

        for (const record of document.sessions) {
            if (record.turnInvocations !== undefined) record.turnInvocations[turnId] = '2';
        }

        writePersistedDocument(root, document);

        const restored = createStore(instructPreset(), persistence, persistence.load());

        // The child row still names `WE1`/`thread-2` — the conversation its OWN run ran in — and
        // the root row keeps the conversation the RECORD states. Before the fix the child row read
        // `IT1`, because the turn's root-invocation loop overwrote the join's entry for id `2`.
        expect(sectionsOf(restored, id, turnId)).toEqual([
            { agent: 'instruct', agentLabel: 'IT1', invocationId: '1', threadId: 'thread-1' },
            { agent: 'workspace', agentLabel: 'WE1', invocationId: '2', threadId: 'thread-2' }
        ]);

        // The roster keeps every conversation's own ids, and the borrowed origin id does not
        // relocate a run: `2` is listed for the main conversation ONLY because the turn now names
        // it as that conversation's origin run.
        expect(rosterJoinOf(restored.get(id))).toEqual([
            ['IT1', '1', ['1', '2'], '2'],
            ['WE1', '2', ['2'], undefined]
        ]);

        restored.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('resolves a pre-change (bare-id) join unchanged and refuses a foreign run key (J2, J3)', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 'r19-join-legacy-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore(instructPreset(), persistence);
        const id = (await store.create('instruct')).id;
        const task = await submit(store, id, 'delegate please');
        const turnId = task.turnId;

        // A document written by THIS build keys the join by invocation RUN (`id\0epoch`, the epoch
        // being this process's `HARNESS_PROCESS_EPOCH` — one module registry, hence one epoch, per
        // test file). The exact keys, not a prefix match: the shape of the join is the contract.
        const current = readPersistedDocument(root) as unknown as {
            sessions: { invocationThreads?: Record<string, string> }[];
        };

        expect(Object.keys(current.sessions[0]?.invocationThreads ?? {})).toEqual([
            invocationRunKeyOf('1', HARNESS_PROCESS_EPOCH),
            invocationRunKeyOf('2', HARNESS_PROCESS_EPOCH)
        ]);

        store.dispose();

        // J2: STRIP the epoch half — the join is now exactly what a pre-change document holds,
        // while the recorded frames still carry their epochs. Every row must resolve through the
        // bare-id door, with the same conversation and the same name it had before this change.
        const legacyDocument = readPersistedDocument(root) as unknown as {
            sessions: { invocationThreads?: Record<string, string> }[];
        };

        for (const record of legacyDocument.sessions) {
            if (record.invocationThreads === undefined) continue;

            record.invocationThreads = Object.fromEntries(
                Object.entries(record.invocationThreads).map(([runKey, threadId]) => [
                    invocationIdOfRunKey(runKey),
                    threadId
                ])
            );
        }

        writePersistedDocument(root, legacyDocument);

        const legacy = createStore(instructPreset(), persistence, persistence.load());

        expect(sectionsOf(legacy, id, turnId)).toEqual([
            { agent: 'instruct', agentLabel: 'IT1', invocationId: '1', threadId: 'thread-1' },
            { agent: 'workspace', agentLabel: 'WE1', invocationId: '2', threadId: 'thread-2' }
        ]);

        // The roster strips the epoch half at the wire boundary: bare ids, this conversation's own.
        expect(rosterJoinOf(legacy.get(id))).toEqual([
            ['IT1', '1', ['1'], '1'],
            ['WE1', '2', ['2'], undefined]
        ]);

        legacy.dispose();

        // J3: add a run-keyed entry for a DIFFERENT process claiming that id `2` belonged to the
        // MAIN conversation — the shape a restarted harness produces. It must not move the child
        // row, because the child's frames name their own process, and the roster for the main
        // conversation gains the bare id `2` from this run without losing `1`.
        const withForeign = readPersistedDocument(root) as unknown as {
            sessions: { invocationThreads?: Record<string, string> }[];
        };

        for (const record of withForeign.sessions) {
            if (record.invocationThreads === undefined) continue;

            record.invocationThreads[invocationRunKeyOf('2', 'epoch-other-process')] = 'thread-1';
        }

        writePersistedDocument(root, withForeign);

        const reloaded = createStore(instructPreset(), persistence, persistence.load());

        expect(sectionsOf(reloaded, id, turnId)).toEqual([
            { agent: 'instruct', agentLabel: 'IT1', invocationId: '1', threadId: 'thread-1' },
            { agent: 'workspace', agentLabel: 'WE1', invocationId: '2', threadId: 'thread-2' }
        ]);

        expect(rosterJoinOf(reloaded.get(id))).toEqual([
            // `2` IS one of this conversation's runs now (the other process's), and the wire still
            // carries it as a bare id.
            ['IT1', '1', ['1', '2'], '1'],
            ['WE1', '2', ['2'], undefined]
        ]);

        reloaded.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
});

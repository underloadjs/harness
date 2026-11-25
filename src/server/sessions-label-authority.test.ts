// F3/S4 (2026-11-25) — ONE NAME PER CONVERSATION: THE LABEL MAP IS THE AUTHORITY, AND A RUNTIME
// ROW COPY THAT DRIFTS FROM IT IS REPAIRED, NOT SERVED.
//
// THE DEFECT THE OPERATOR'S DUMP MEASURES. Every SERVED surface already resolves a conversation's
// display name THROUGH the store's allocation map (`threadRoster` overrides `label` with
// `ensureThreadLabel`; `../api-reads.ts` `threadRowOf` builds its row field from the name `../api.ts`
// `labelOf` reads out of the map). What can still disagree is the RUNTIME's committed row copy —
// `Session.core.threads[].label` — which is what `../harness.ts` `modelThreadRosterOf` publishes to
// the model and what `../core/thread.ts` `resolveThreadAddressOf` matches a `#WE6`-style reference
// against. The operator's own session (`e513eed7-7c44-487f-a60c-18f69d9fca68`, read-only dump) shows
// 3 of 70 rows wearing a retired name: `thread-6` record `WE1` / map `WE2`, `thread-40` `WE3` /
// `WE10`, `thread-42` `RH1` / `RH4`. So a row answers a `#` reference the store resolves to a
// DIFFERENT conversation, and every restart re-seeds the records from that copy.
//
// WHY `mirrorThreadLabel` ALONE LEFT IT BROKEN. The mirror writes through a live handle, and it
// refuses a conversation `harness.thread()` does not return — which is the ordinary state of a
// SOFT-DELETED (retained) row, and exactly where the drift survived a checkpoint. The rule under
// test (./sessions.ts `reconcileThreadLabelRecords`, called at the end of `ensureThreadLabels` for
// reads and in `sessionRecord()` for writes) is therefore REPAIR-ON-READ: it walks the row copies,
// and for every row whose label differs from the map it pushes the map's name onto the handle
// (`mirrorThreadLabel`) and onto the committed copy. It never moves authority the other way, so the
// map keeps the name it allocated, and it touches nothing on a session that already agrees — no
// session file is rewritten by the reconciliation itself (the next ordinary checkpoint just persists
// the name the map has held all along).
//
// Run: yarn vitest run src/server/sessions-label-authority.test.ts   (cwd packages/underload/harness)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agent, harness } from '../engine/harness';
import type { HarnessStreamEvent } from '../engine/harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { HarnessPersistence } from './persistence';
import { readPersistedDocument } from './persistence-test-helpers';
import { SessionStore } from './sessions';
import type { SessionSnapshot } from './protocol';

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'super-secret-key',
    model: 'scripted/test'
};

// `researcher` is code RR (first+last ASCII letter), so every assertion below is a literal the
// reader can verify against the map by eye.
const researcherPreset = (): HarnessPreset => ({
    name: 'researcher',
    title: 'researcher',
    description: 'researcher scripted preset',
    requiresEndpoint: false,
    entry: 'researcher',
    ranks: { researcher: 'A' },
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
            entry: 'researcher',
            presets: false,
            report: { progress }
        })
});

const createStore = (
    preset: HarnessPreset,
    persistence?: HarnessPersistence,
    database?: ReturnType<HarnessPersistence['load']>
): SessionStore =>
    new SessionStore(SETTINGS, createHarnessRegistry([preset]), undefined, {
        ...(persistence === undefined ? {} : { persistence }),
        ...(database === undefined ? {} : { database })
    });

const submit = async (
    store: SessionStore,
    id: string,
    prompt: string,
    threadId?: string
): Promise<{ label: string | undefined; threadId: string; turnId: string }> => {
    const task = await store.enqueue(id, prompt, undefined, undefined, threadId);

    await task.settled;
    await store.waitForIdle(id);

    return {
        label: task.turn.threadLabel,
        threadId: task.turn.threadId as string,
        turnId: task.turn.id
    };
};

// Served roster names, in creation order (the map-authoritative surface a client reads).
const rosterLabels = (snapshot: SessionSnapshot): string[] => (snapshot.threads ?? []).map((thread) => thread.label);

// The RUNTIME's committed copy — the half that could drift, and the one under test.
const rowLabels = (store: SessionStore, id: string): Array<{ id: string; label: string | undefined }> =>
    (store.liveSession(id).core.threads ?? []).map((row) => ({ id: row.id, label: row.label }));

const tempRoot = (prefix: string): string => fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), prefix));

describe('the label map owns every copy of a conversation name', () => {
    it('repairs a row copy wearing a retired name, without renaming the conversation', async () => {
        const store = createStore(researcherPreset());
        const id = (await store.create('researcher')).id;

        const one = await submit(store, id, 'first');
        const two = await submit(store, id, 'second');

        expect([one.label, two.label]).toEqual(['RR1', 'RR2']);
        expect(rosterLabels(store.get(id))).toEqual(['RR1', 'RR2']);

        const live = store.liveSession(id);

        // Precondition: the copy starts out agreeing with the map, so the tamper below is the ONLY
        // difference in the session — the exact state of `thread-6`/`WE1` in the operator's dump.
        expect(live.core.threads?.find((row) => row.id === one.threadId)?.label).toBe('RR1');

        const stale = live.core.threads?.find((row) => row.id === one.threadId);

        if (stale === undefined) throw new Error(`no core row for ${one.threadId}`);

        stale.label = 'WE9';

        // The read path repairs it: `store.get` takes the `ensureThreadLabels` pass, and that pass
        // now pushes the map's name back onto every copy it finds disagreeing.
        const snapshot = store.get(id);

        expect(rosterLabels(snapshot)).toEqual(['RR1', 'RR2']);
        expect(rowLabels(store, id)).toEqual([
            { id: one.threadId, label: 'RR1' },
            { id: two.threadId, label: 'RR2' }
        ]);

        // The MODEL-facing record is repaired on the same pass, so `resolveThreadAddressOf` answers
        // `#RR1` for this conversation and not for some other one.
        expect(live.harness.thread(one.threadId)?.label).toBe('RR1');

        // Authority never travels the other way: the map still holds what it allocated, and a second
        // read changes nothing (the repair is idempotent, so a steady session keeps writing nothing).
        expect(live.threadLabels.get(one.threadId)).toBe('RR1');
        store.get(id);
        expect(rowLabels(store, id)).toEqual([
            { id: one.threadId, label: 'RR1' },
            { id: two.threadId, label: 'RR2' }
        ]);

        store.dispose();
    });

    it('repairs a retained (soft-deleted) row the live handle cannot even reach', async () => {
        const store = createStore(researcherPreset());
        const id = (await store.create('researcher')).id;

        const one = await submit(store, id, 'first');
        const two = await submit(store, id, 'second');

        // The case `mirrorThreadLabel` alone cannot serve: the conversation is retired, its turn row
        // is retained, and the handle refuses it — so nothing else in the store can rewrite its copy.
        await store.deleteThread(id, one.threadId);

        const live = store.liveSession(id);

        expect(live.harness.thread(one.threadId)).toBeUndefined();

        const stale = live.core.threads?.find((row) => row.id === one.threadId);

        if (stale === undefined) throw new Error(`the retained row for ${one.threadId} left the document`);

        stale.label = 'WE9';

        store.get(id);

        expect(rowLabels(store, id)).toEqual([
            { id: one.threadId, label: 'RR1' },
            { id: two.threadId, label: 'RR2' }
        ]);

        // Only the SURVIVING conversation is served, and it is served with the map's name.
        expect(rosterLabels(store.get(id))).toEqual(['RR2']);

        store.dispose();
    });

    it('persists the map name, so the drift cannot come back after a restart', async () => {
        const root = tempRoot('f3-label-authority-');
        const persistence = new HarnessPersistence(root);
        const store = createStore(researcherPreset(), persistence);
        const id = (await store.create('researcher')).id;

        const one = await submit(store, id, 'first');

        const live = store.liveSession(id);
        const stale = live.core.threads?.find((row) => row.id === one.threadId);

        if (stale === undefined) throw new Error(`no core row for ${one.threadId}`);

        stale.label = 'WE9';

        // The read repairs, and the ordinary checkpoint that follows persists the REPAIRED name —
        // which is the copy `harness.restore()` re-seeds the runtime's records from.
        expect(rosterLabels(store.get(id))).toEqual(['RR1']);

        store.dispose();

        const document = readPersistedDocument(root);
        const session = document.sessions.find((entry: { id: string }) => entry.id === id);

        expect(session.core.threads.find((row: { id: string }) => row.id === one.threadId).label).toBe('RR1');
        expect(session.threadLabels).toEqual({ [one.threadId]: 'RR1' });

        // A restart therefore cannot resurrect the retired name.
        const restored = createStore(researcherPreset(), persistence, persistence.load());

        expect(rosterLabels(restored.get(id))).toEqual(['RR1']);
        expect(rowLabels(restored, id)).toEqual([{ id: one.threadId, label: 'RR1' }]);

        restored.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
});

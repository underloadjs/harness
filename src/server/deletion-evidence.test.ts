// F7 (2026-11-17): a soft-deleted conversation must carry DELETION EVIDENCE across a reload.
//
// THE DEFECT. `deleteThread` is a MARK, not a purge: it stamps `inactive: true` on the retained
// row (./sessions.ts `deleteThread`) and the roster then HIDES that conversation — `threadRoster`
// (./sessions.ts, the single place `snapshot()`, `viewOf()` and `viewSummaryOf()` get a roster)
// and its REST twin `threadRecordsOf` (./api.ts) both filter `inactive !== true`. A client that
// WATCHED the delete handles that fine (the id simply leaves the roster it was given, and
// `frontend/ui/threads.ts` treats a removal from a NON-EMPTY roster as evidence). A RELOAD is the
// other case: the board never saw the conversation, and "the roster does not name this id" is
// indistinguishable from "this conversation never existed" — so the retired conversation's
// sections render again as placeholder rows, which is the reported symptom.
//
// WHAT FIXES IT (option (b), chosen over forwarding the row): the deletion fact travels as its OWN
// field beside the roster — `SessionSnapshot.inactiveThreads` / `SessionView.inactiveThreads`
// (./protocol.ts) and the REST `SessionResource.inactive_thread_ids` (./harness.swagger.yaml,
// generated into ./shared/harness-api.ts, emitted by ./api-reads.ts `sessionResourceOf`). Forwarding
// the row instead would have widened every gate built on the roster (`defaultThreadId`, the roster
// "names it" checks, `thread_count`), which is why the roster keeps meaning "the conversations this
// session can still RUN" and the marker rides separately.
//
// THESE TESTS PIN:
//   1. the live delete: the roster omits the conversation AND both session headers name it;
//   2. the RELOAD (the case the roster cannot answer): a second store over the same database still
//      reports the marker, and still hides the row;
//   3. the REST projection: `inactive_thread_ids` on the identified session read, ABSENT when
//      nothing was deleted, and `thread_count` unchanged by the deletion (the filter's meaning is
//      not widened);
//   4. the additive rule: a session that never deleted a conversation carries NEITHER field, and a
//      deleted-then-REVIVED conversation is re-listed with the marker lifted.
//
// Cross-references:
//   - ./sessions.ts — `inactiveThreadIdsOf` (ledger ∪ `inactive: true` rows), `isThreadInactive`,
//     `threadRoster`, `deleteThread`, `resumeThread`
//   - ./api-reads.ts — `retiredThreadIdsOf` (the turns page's predicate, the same source),
//     `sessionResourceOf`
//   - ./api.ts — `threadRecordsOf` (the REST roster filter), `liveSession`
//   - ../frontend/ui/threads.ts — the client's two evidence rules (POSITIVE marker, REMOVAL)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessPreset } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { HarnessPersistence } from './persistence';
import { sessionResourceOf, type ReadContext } from './api-reads';
import { SessionStore } from './sessions';

const SETTINGS = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'super-secret-key',
    model: 'scripted/test'
};

const presetOf = (name: string, create: HarnessPreset['create']): HarnessPreset => ({
    name,
    title: name,
    description: `${name} scripted preset`,
    requiresEndpoint: false,
    // A ONE-member card: `ranks` covers the single member, which is also the entry (routing).
    // One distinct rank means nobody sits strictly below it, so the runtime registers no
    // `delegate` row — exactly what the retired `subagents: []` stated (R15).
    entry: name,
    ranks: { [name]: 'A' },
    agents: [name],
    tools: [],
    builtin: true,
    editable: true,
    create
});

// A scripted transport that ALWAYS answers. Nothing here is about a failing run — the fact under
// test is a deletion and what a reload remembers about it — and an answered turn is what leaves a
// conversation with a transcript and a label to be deleted.
const answeringPreset = (): HarnessPreset =>
    presetOf('probe', (_settings, progress) =>
        harness({
            agents: {
                probe: agent({
                    model: _settings.model,
                    instruction: 'sys',
                    stream: async function* (): AsyncGenerator<{ type: string; delta?: string }> {
                        yield { type: 'text', delta: 'answer' };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            entry: 'probe',
            presets: false,
            // The store's recorder rides the harness's own progress report; without this the turn
            // never records its frames (./harnesses/types.ts `HarnessPreset.create`).
            report: { progress }
        })
    );

const createStore = (
    preset: HarnessPreset,
    persistence?: HarnessPersistence,
    database?: ReturnType<HarnessPersistence['load']>
): SessionStore =>
    new SessionStore(SETTINGS, createHarnessRegistry([preset]), undefined, {
        ...(persistence === undefined ? {} : { persistence }),
        ...(database === undefined ? {} : { database })
    });

const tempRoot = (label: string): string => fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), `f7-${label}-`));

// One submit, awaited to its terminal transition and then to a drained store, so the roster the
// test reads afterwards is the one a reload would rebuild from the document.
const submit = async (store: SessionStore, id: string, prompt: string, threadId?: string) => {
    const task = await store.enqueue(id, prompt, undefined, undefined, threadId);

    await task.settled;
    await store.waitForIdle(id);

    return task;
};

// A hand-built read context over the projections: only the fields `sessionResourceOf` actually
// consults (hub counters, the process title map, deployment runtime, the tool budget). Everything
// it reports about THIS session comes from the live record, which is the point of the test.
const readContext = (): ReadContext =>
    ({
        hub: { getRevision: () => 0 },
        catalogue: [],
        defaults: { baseURL: SETTINGS.baseURL, model: SETTINGS.model, apiKey: SETTINGS.apiKey },
        runtime: { threadExecution: 'inline' },
        titles: new Map<string, string>(),
        createdToolLimit: 32,
        profiles: []
    }) as unknown as ReadContext;

afterEach(() => {
    vi.restoreAllMocks();
});

describe('F7: a soft-deleted conversation carries its deletion evidence', () => {
    it('hides the conversation from the roster and names it in both session headers', async () => {
        const root = tempRoot('live');
        const store = createStore(answeringPreset(), new HarnessPersistence(root));
        const id = (await store.create('probe')).id;

        await submit(store, id, 'first');
        await submit(store, id, 'second', 'thread-1');

        // The roster BEFORE the delete: both conversations are listed, no marker field at all.
        expect(store.get(id).threads?.map((thread) => thread.id)).toEqual(['thread-1']);
        expect(store.get(id).inactiveThreads).toBeUndefined();

        const deleted = await store.deleteThread(id, 'thread-1');

        // The receipt is a snapshot, and it already carries the marker: a client holding the
        // response knows the conversation was DELETED, not merely dropped.
        expect(deleted.inactiveThreads).toEqual(['thread-1']);
        expect(deleted.threads?.map((thread) => thread.id) ?? []).toEqual([]);

        // The store surfaces agree, and the roster keeps its narrow meaning (the deleted row is
        // not merely marked, it is absent from the discovery surface).
        expect(store.get(id).inactiveThreads).toEqual(['thread-1']);
        expect(store.get(id).threads?.map((thread) => thread.id) ?? []).toEqual([]);

        const view = store.getView(id);

        expect(view.inactiveThreads).toEqual(['thread-1']);
        expect(view.threadViews?.map((thread) => thread.id) ?? []).toEqual([]);
        // The ledger is untouched by a mark: both turn rows are still addressable (R2).
        expect(view.turns.map((turn) => turn.prompt)).toEqual(['first', 'second']);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('survives a reload: a fresh store over the same database still carries the marker', async () => {
        const root = tempRoot('reload');
        const persistence = new HarnessPersistence(root);
        const store = createStore(answeringPreset(), persistence);
        const id = (await store.create('probe')).id;

        await submit(store, id, 'kept');
        await submit(store, id, 'gone', 'thread-1');
        await store.deleteThread(id, 'thread-1');
        store.dispose();

        // THE RELOAD. The board never saw the deletion, and the roster it is handed omits the id —
        // the only thing that can tell "deleted" from "never existed" is this field, and it has to
        // come out of the DOCUMENT, not out of process memory.
        const reloaded = createStore(answeringPreset(), persistence, persistence.load());
        const snapshot = reloaded.get(id);

        expect(snapshot.inactiveThreads).toEqual(['thread-1']);
        expect(snapshot.threads?.map((thread) => thread.id) ?? []).toEqual([]);
        expect(reloaded.getView(id).inactiveThreads).toEqual(['thread-1']);
        // The retained ledger is what makes it durable: the rows the delete kept are still there,
        // so the reload can neither invent nor forget the conversation.
        expect(snapshot.turns.map((turn) => `${turn.prompt}:${turn.status}`)).toEqual(['kept:done', 'gone:done']);

        // A SECOND restart proves the marker is not a one-hop projection of in-memory state: the
        // restored store re-emits it without anything having touched the session in between.
        reloaded.dispose();
        const again = createStore(answeringPreset(), persistence, persistence.load());

        expect(again.get(id).inactiveThreads).toEqual(['thread-1']);
        expect(again.getView(id).inactiveThreads).toEqual(['thread-1']);

        again.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('publishes inactive_thread_ids on the identified session read, and widens nothing else', async () => {
        const root = tempRoot('rest');
        const persistence = new HarnessPersistence(root);
        const store = createStore(answeringPreset(), persistence, undefined);
        const id = (await store.create('probe')).id;

        await submit(store, id, 'kept');
        await submit(store, id, 'gone', 'thread-1');

        // Nothing deleted yet: the key is ABSENT, so a pre-F7 client reads the identical resource.
        const before = sessionResourceOf(store.liveSession(id), readContext());

        expect(before.inactive_thread_ids).toBeUndefined();
        expect(before.thread_count).toBe(1);

        await store.deleteThread(id, 'thread-1');

        const after = sessionResourceOf(store.liveSession(id), readContext());

        expect(after.inactive_thread_ids).toEqual(['thread-1']);
        // THE FILTER IS NOT WIDENED: a retired conversation still does not count as one this
        // session can RUN — the count moves exactly as the roster does, which is why the marker
        // could not ride on the roster row (that row list is the count's source).
        expect(after.thread_count).toBe(0);
        // The ledger is untouched by the mark: both turn rows are still there.
        expect(after.turn_count).toBe(2);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('reports no marker for a session that never deleted one, and drops it when the row comes back', async () => {
        const root = tempRoot('clean');
        const persistence = new HarnessPersistence(root);
        const store = createStore(answeringPreset(), persistence);
        const clean = (await store.create('probe')).id;

        await submit(store, clean, 'only');

        expect(store.get(clean).inactiveThreads).toBeUndefined();
        expect(store.getView(clean).inactiveThreads).toBeUndefined();
        expect(sessionResourceOf(store.liveSession(clean), readContext()).inactive_thread_ids).toBeUndefined();

        // The marker's whole life is derived from the retained row, so it has to END when the row
        // is revived. The revive door here is a SUBMIT, not `resumeThread`: this conversation's
        // newest turn is `done`, and the resume route refuses to re-run an answer the user already
        // has (./sessions.ts `resumeThread` "already reached its answer"), while `enqueue` with the
        // retained thread id resolves the retired row and reactivates it the same way (F-A Defect 2
        // — see `reactivateThreadRow`, which drops both the ledger entry and the row's mark).
        const id = (await store.create('probe')).id;

        // The session's default host conversation is minted by its FIRST host submit (a fresh
        // session has no thread row at all), and that minted id is the one the delete retires.
        await submit(store, id, 'gone');
        await store.deleteThread(id, 'thread-1');
        expect(store.get(id).inactiveThreads).toEqual(['thread-1']);

        await submit(store, id, 'again', 'thread-1');

        expect(store.get(id).inactiveThreads).toBeUndefined();
        expect(store.get(id).threads?.map((thread) => thread.id) ?? []).toEqual(['thread-1']);
        expect(sessionResourceOf(store.liveSession(id), readContext()).inactive_thread_ids).toBeUndefined();

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
});

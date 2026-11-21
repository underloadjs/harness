// W26 (2026-11-17) — THE ROSTER ROW'S IDENTITY BLOCK: `invocation_id` + `invocation_ids` + `epoch`,
// projected under ONE rule, in a MEASURED key order.
//
// WHY THIS FILE EXISTS. W22 published the process token (`epoch`) on the REST roster row while
// `ThreadSummary` itself carried NO invocation id (the R1 compact-roster decision). That left the token
// unpairable exactly where it is consumed: `../frontend/view-shell.ts` `getRawSession` — the transcript
// dialog and the JSON export, called from `../frontend/main.ts` on the explicit export action — builds its
// roster rows out of THIS page (`../frontend/view-api.ts` `threadRowOf`), so on that path a client received
// a process with no invocation id beside it and the invocation -> conversation join
// (`../frontend/ui/thread-transcript.ts` `attributedThreadOf`, door 1) still could not key a contested id.
// The discriminator therefore worked only on the planes that already publish ids
// (`./protocol.ts` `SessionThread.invocationIds` / `SessionThreadView.invocationIds`), which made the answer
// depend on which read the client happened to make.
//
// THE EMIT RULE (`./api-reads.ts` `threadRowOf`), stated once so the pins below are the contract:
//   * `invocation_id`   — present exactly when the conversation's RECORD names a run
//                         (`HarnessThreadRecord.invocationId`), value BARE;
//   * `invocation_ids`  — present exactly when anything was recorded for it: the persisted join
//                         (`SessionRecord.invocationThreads`, keyed by RUN, stripped by `invocationIdOfRunKey`)
//                         in observation order, UNIONED with the record's own slot (the store's own rule,
//                         `./sessions.ts` `invocationIdsOf`), capped at 64;
//   * `epoch`           — present exactly when the record PAIRS its id with the process that minted it;
//   * every value is BARE — the composite `id\0epoch` never crosses this wire
//                         (`../shared/run-identity.ts`), so a reported id can go straight back to the
//                         transcript routes (`./api-mutations.ts` `parseTranscriptInvocationId`).
//
// WHY THE RECORD SLOT IS UNIONED IN AND NOT MERELY THE JOIN. The reference session
// (`Temp/orch-plan/report.md`, 17 conversations) is the proof: its join names `15 → thread-14` while
// `thread-13`'s OWN record carries `invocationId: '15'` — the recycled id the pre-restart conversation
// actually ran. A row built from the join alone hides that claimant, so the collision the whole change is
// about would be invisible on the export plane. Pinned below as the "join cleared" case.
//
// WHAT IS PINNED HERE (a real run through the canonical routes, plus the two shapes a client meets after a
// restart or a delete):
//   W26-1 — the shape that RAN: exact key order, exact values, both ids bare, `epoch` present ONLY beside
//           its id, and the page's exact byte delta;
//   W26-2 — the shape that NEVER RAN: no identity block at all, so the row is byte-identical to what the
//           same route sent before the field existed;
//   W26-3 — the SOFT-DELETED shape: the roster page still hides the row (`./api.ts` `threadRecordsOf`), and
//           the row the retained record projects keeps the identity block, in the same key order;
//   W26-4 — the LEGACY shape: a document with no epoch anywhere gains the two id keys and stays epoch-free;
//   W26-5 — the JOIN-CLEARED shape: the durable join names nothing, and the row still names the run its own
//           record carries (this is the reference session's shape, where the recycled `15` would otherwise
//           have no claimant at all on this plane).
//
// Run: yarn vitest run src/server/api-thread-roster-invocation-ids.test.ts
//
// Cross-references: ./api-reads.ts `threadRowOf`/`rosterInvocationIdsOf` (the producer),
// ./api.ts `threadRecordsOf`/`threadRowFor` (the page), ../frontend/view-api.ts `threadRowOf` (the rename),
// ../frontend/ui/thread-transcript-run-join.test.ts F7 (the export-path join this feeds),
// ./sessions.epoch-discrimination.test.ts (the durable join, and D1-D3 whose wire half is pinned there),
// ./api-canonical.test.ts (the roster row's key SET), ../harness.thread-epoch.test.ts (the runtime pair).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agent, harness } from '../engine/harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { HarnessPersistence } from './persistence';
import { harnessSessionFileOf, readPersistedDocument, writePersistedDocument } from './persistence-test-helpers';
import { SessionStore } from './sessions';
import { createHarnessApi } from './api';
import type { HarnessApiRequest, HarnessApiResult } from './api';
import { threadRowOf } from './api-reads';
import { HARNESS_PROCESS_EPOCH } from '../engine/core/agent-limits';
import type { HarnessThreadRecord } from '../engine/types';

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'server-secret',
    model: 'scripted/test'
};

// `instruct` (code IT) delegates once to `workspace` (code WE): one process, two conversations, two runs
// (`1` then `2`), and the delegated child is the row that carries `owner_thread_id`. Same fixture as
// ./sessions.epoch-discrimination.test.ts, copied so this file owns its own expectations.
const instructPreset = (): HarnessPreset => ({
    name: 'instruct',
    title: 'instruct',
    description: 'instruct scripted preset',
    requiresEndpoint: false,
    // R15 — `entry` routes, `ranks` grant authority: `instruct` is Rank A and `workspace`
    // is strictly below it, which is the only reason the delegated child can be addressed at all.
    entry: 'instruct',
    ranks: { instruct: 'A', workspace: 'B' },
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
                    stream: async function* (request): AsyncGenerator<any> {
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
                                { id: 'call_1', name: 'delegate', arguments: '{"agent":"workspace","input":"find it"}' }
                            ]
                        };
                    }
                }),
                workspace: agent({
                    model: settings.model,
                    instruction: 'Answer the instruct.',
                    stream: async function* (): AsyncGenerator<any> {
                        yield { type: 'text', delta: 'child answer' };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            entry: 'instruct',
            ranks: { instruct: 'A', workspace: 'B' },
            presets: false,
            report: { progress }
        })
});

// A DEDICATED sandbox root per case (`fs.mkdtempSync`, unique per run) — a store write is allowed to reset
// its own root and nothing here shares a probe directory with another task.
const sandbox = (): string => fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 'w26-roster-identity-'));

const apiOf = (store: SessionStore) =>
    createHarnessApi({
        store,
        defaults: { baseURL: SETTINGS.baseURL, model: SETTINGS.model, hasApiKey: true },
        registry: createHarnessRegistry([instructPreset()])
    });

const call = async (api: ReturnType<typeof createHarnessApi>, method: string, pathname: string, body?: unknown) => {
    const result: HarnessApiResult = await (
        api as unknown as (request: HarnessApiRequest) => Promise<HarnessApiResult>
    )({
        method,
        pathname,
        mount: '/v1/harness',
        readBody: async <T>() => (body === undefined ? ({} as T) : (body as T))
    });

    if (result.kind !== 'json') throw new Error(`expected a json result, got ${result.kind}`);

    return result.body as Record<string, any>;
};

const rosterOf = async (api: ReturnType<typeof createHarnessApi>, sessionId: string): Promise<Record<string, any>[]> =>
    (await call(api, 'GET', `/v1/harness/sessions/${sessionId}/threads`)).items as Record<string, any>[];

// One session that has run: root `thread-1` (`IT1`, invocation `1`) and its delegated child `thread-2`
// (`WE1`, invocation `2`), both minted by THIS process.
const ranSession = async (root: string) => {
    const persistence = new HarnessPersistence(root);
    const store = new SessionStore(SETTINGS, createHarnessRegistry([instructPreset()]), undefined, { persistence });
    const api = apiOf(store);
    const created = await store.create('instruct');
    const task = await store.enqueue(created.id, 'delegate please', undefined, undefined, undefined);

    await task.settled;
    await store.waitForIdle(created.id);

    return { persistence, store, api, sessionId: created.id };
};

// The identity block of one row, exactly as the wire holds it.
const identityOf = (row: Record<string, any>) => ({
    invocation_id: row.invocation_id,
    invocation_ids: row.invocation_ids,
    epoch: row.epoch
});

// Bytes one added key costs: key + JSON value + the separating comma.
const keyBytes = (key: string, value: unknown): number =>
    Buffer.byteLength(`"${key}":${JSON.stringify(value)}`, 'utf8') + 1;

describe('the roster row names its own run (W26)', () => {
    it('emits invocation_id + invocation_ids + epoch in one measured key order (shape b: a conversation that ran)', async () => {
        const root = sandbox();
        const { store, api, sessionId } = await ranSession(root);
        const rows = await rosterOf(api, sessionId);

        expect(rows.map((row) => row.id)).toEqual(['thread-1', 'thread-2']);

        // THE KEY ORDER, measured, not reasoned about. The three identity keys sit together — id, ids,
        // process — immediately after the row's naming fields and before `transcript_state`. Every key that
        // existed before this change keeps BOTH its position and its value: the only difference from the
        // pre-W26 row is the inserted block (pinned against the byte-for-byte older row in W26-2 below).
        expect(Object.keys(rows[0] as object)).toEqual([
            'id',
            'agent',
            'origin',
            'status',
            'sequence',
            'label',
            'invocation_id',
            'invocation_ids',
            'epoch',
            'transcript_state',
            'message_count',
            'chars',
            'has_transcript'
        ]);
        // A delegated child adds `owner_thread_id` where it always sat (after `sequence`); the identity
        // block still follows the naming fields, so the insertion point does not move per row shape.
        expect(Object.keys(rows[1] as object)).toEqual([
            'id',
            'agent',
            'origin',
            'status',
            'sequence',
            'owner_thread_id',
            'label',
            'invocation_id',
            'invocation_ids',
            'epoch',
            'transcript_state',
            'message_count',
            'chars',
            'has_transcript'
        ]);

        // THE VALUES. One run per conversation, so `invocation_ids` holds exactly the id the record carries,
        // and `epoch` is the process that minted it — the pair the runtime writes in ONE statement
        // (../harness.ts `markThreadEpoch`), read back here as two bare fields.
        expect(rows.map(identityOf)).toEqual([
            { invocation_id: '1', invocation_ids: ['1'], epoch: HARNESS_PROCESS_EPOCH },
            { invocation_id: '2', invocation_ids: ['2'], epoch: HARNESS_PROCESS_EPOCH }
        ]);
        expect(rows[0].label).toBe('IT1');
        expect(rows[1].label).toBe('WE1');
        expect(rows[1].owner_thread_id).toBe('thread-1');

        // BARE, never the composite. A reported id is what a client sends back to the transcript routes
        // (`./api-mutations.ts` `parseTranscriptInvocationId`), so a NUL here would be a key that was never
        // minted (`../shared/run-identity.ts`).
        for (const row of rows) {
            expect(row.invocation_id.includes('\u0000')).toBe(false);

            for (const id of row.invocation_ids as string[]) expect(id.includes('\u0000')).toBe(false);
        }

        // THE PAYLOAD, measured on the fixture: one `"invocation_id":"N",` and one
        // `"invocation_ids":["N"],` per row, two rows. `epoch` rode this row before W26, so it is part of
        // the base line here, not part of the delta.
        const withIdentity = JSON.stringify(rows);
        const withoutIdentity = JSON.stringify(
            rows.map((row) => {
                const { invocation_id: _id, invocation_ids: _ids, ...rest } = row;

                return rest;
            })
        );

        expect(Buffer.byteLength(withIdentity, 'utf8') - Buffer.byteLength(withoutIdentity, 'utf8')).toBe(
            2 * (keyBytes('invocation_id', '1') + keyBytes('invocation_ids', ['1']))
        );

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('emits no identity block at all for a conversation that never ran (shape a: byte-identical)', async () => {
        const root = sandbox();
        const { store, api, sessionId } = await ranSession(root);

        // A conversation opened by the create route and never given work: no run, therefore no id, therefore
        // no process. `./api-reads.ts` `threadRowOf` emits NONE of the three keys (never `[]`, never `''`).
        const created = await call(api, 'POST', `/v1/harness/sessions/${sessionId}/threads`, { agent: 'workspace' });
        const rows = await rosterOf(api, sessionId);
        const fresh = rows.find((row) => row.id === created.thread.id) as Record<string, any>;

        expect(fresh.id).toBe('thread-3');
        expect('invocation_id' in fresh).toBe(false);
        expect('invocation_ids' in fresh).toBe(false);
        expect('epoch' in fresh).toBe(false);
        expect(Object.keys(fresh)).toEqual([
            'id',
            'agent',
            'origin',
            'status',
            'sequence',
            'transcript_state',
            'message_count',
            'chars',
            'has_transcript'
        ]);
        // The whole row, byte for byte, is what the route sent before W26 (the create receipt proves the
        // conversation is otherwise untouched: its transcript holds only the harness's opening entry).
        expect(JSON.stringify(fresh)).toBe(
            '{"id":"thread-3","agent":"workspace","origin":"host","status":"idle","sequence":5,' +
                '"transcript_state":"ok","message_count":1,"chars":20,"has_transcript":true}'
        );
        // The identified read of the same never-ran conversation keeps its OWN insertion order for the
        // required `invocation_ids`: the row seeded nothing, so `threadResourceOf` writes it where it always
        // sat. Nothing about the resource moved for a conversation without a run.
        expect(Object.keys(created.thread)).toEqual([
            'id',
            'agent',
            'origin',
            'status',
            'sequence',
            'transcript_state',
            'message_count',
            'chars',
            'has_transcript',
            'session_id',
            'invocation_ids',
            'invocation_ids_truncated',
            'transcript_revision',
            'revision'
        ]);
        expect(created.thread.invocation_ids).toEqual([]);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('hides a soft-deleted conversation from the page but keeps its identity on the projected row (shape c)', async () => {
        const root = sandbox();
        const { store, api, sessionId } = await ranSession(root);

        expect(await rosterOf(api, sessionId)).toHaveLength(2);

        expect((await call(api, 'DELETE', `/v1/harness/sessions/${sessionId}/threads/thread-2`)).thread_id).toBe(
            'thread-2'
        );

        // The page filter is unchanged: a retired conversation is retained, not listed
        // (`./api.ts` `threadRecordsOf`), so the roster page still answers one row.
        const rows = await rosterOf(api, sessionId);

        expect(rows.map((row) => row.id)).toEqual(['thread-1']);

        // The RETAINED record still pairs its run with its process, and the row that record projects keeps
        // the identity block in the SAME measured order — a deleted conversation's evidence does not degrade
        // when the roster hides it (`../frontend/ui/turns-deleted-threads.test.ts` renders that evidence).
        const record = store.liveSession(sessionId);
        const retained = (record.core.threads as HarnessThreadRecord[]).find(
            (row) => row.id === 'thread-2'
        ) as HarnessThreadRecord;

        expect(retained.inactive).toBe(true);
        expect(retained.invocationId).toBe('2');
        expect(retained.epoch).toBe(HARNESS_PROCESS_EPOCH);

        const projected = threadRowOf(record, retained, 'WE1', []) as unknown as Record<string, any>;

        expect(Object.keys(projected)).toEqual([
            'id',
            'agent',
            'origin',
            'status',
            'sequence',
            'owner_thread_id',
            'label',
            'invocation_id',
            'invocation_ids',
            'epoch',
            'transcript_state',
            'message_count',
            'has_transcript'
        ]);
        expect(identityOf(projected)).toEqual({
            invocation_id: '2',
            invocation_ids: ['2'],
            epoch: HARNESS_PROCESS_EPOCH
        });
        expect(projected.transcript_state).toBe('ok');
        // The roster's own transcript-free view of a retired conversation: zero figures, because the caller
        // holds no messages — the identity block is independent of them.
        expect(projected.message_count).toBe(0);
        expect(projected.has_transcript).toBe(false);
        expect('chars' in projected).toBe(false);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('keeps the ids and drops the epoch key for a document with no epoch anywhere (legacy shape)', async () => {
        const root = sandbox();
        const ran = await ranSession(root);

        ran.store.dispose();

        // A document written BEFORE the epoch field: no epoch on any record, join keyed by BARE id. This is
        // every file on disk today (./sessions.epoch-discrimination.test.ts D3).
        const document = readPersistedDocument(root) as {
            sessions: { invocationThreads?: Record<string, string>; core?: { threads?: Record<string, any>[] } }[];
        };

        for (const session of document.sessions) {
            for (const thread of session.core?.threads ?? []) delete thread.epoch;

            if (session.invocationThreads !== undefined) {
                session.invocationThreads = Object.fromEntries(
                    Object.entries(session.invocationThreads).map(([runKey, threadId]) => [
                        runKey.split('\u0000')[0],
                        threadId
                    ])
                );
            }
        }

        writePersistedDocument(root, document);

        const persistence = new HarnessPersistence(root);
        const store = new SessionStore(SETTINGS, createHarnessRegistry([instructPreset()]), undefined, {
            persistence,
            database: persistence.load()
        });
        const api = apiOf(store);
        const rows = await rosterOf(api, ran.sessionId);

        // The two id keys ARRIVE (`invocation_id` is now a `ThreadSummary` property), the epoch key does not
        // exist to arrive with, and the rest of the row is the same measured order minus that one key.
        expect(rows.map(identityOf)).toEqual([
            { invocation_id: '1', invocation_ids: ['1'], epoch: undefined },
            { invocation_id: '2', invocation_ids: ['2'], epoch: undefined }
        ]);
        expect(Object.keys(rows[0] as object)).toEqual([
            'id',
            'agent',
            'origin',
            'status',
            'sequence',
            'label',
            'invocation_id',
            'invocation_ids',
            'transcript_state',
            'message_count',
            'chars',
            'has_transcript'
        ]);
        for (const row of rows) expect('epoch' in row).toBe(false);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('still names the run the durable join does not carry (the reference session has this shape)', async () => {
        // A DEDICATED root again, and this one keeps every epoch: only the JOIN is removed, so the case
        // measures one variable. A reset clears the map (`./sessions.ts:12473`), and the reference session
        // shows the same gap without a reset — its join names `15 -> thread-14` while `thread-13`'s own
        // record carries `invocationId: '15'` (`Temp/orch-plan/report.md`, the run that started this change).
        // A row built from the join alone would answer "no runs" for a conversation the transcript fold needs
        // as a CLAIMANT of that recycled id, so the collision would never be seen as one.
        const root = sandbox();
        const ran = await ranSession(root);

        ran.store.dispose();

        const document = readPersistedDocument(root) as { sessions: { invocationThreads?: Record<string, string> }[] };

        for (const session of document.sessions) session.invocationThreads = {};

        writePersistedDocument(root, document);

        const persistence = new HarnessPersistence(root);
        const store = new SessionStore(SETTINGS, createHarnessRegistry([instructPreset()]), undefined, {
            persistence,
            database: persistence.load()
        });
        const rows = await rosterOf(apiOf(store), ran.sessionId);

        // The join names NOTHING for either conversation, and both rows still name their own run — the
        // record-slot half of `./api-reads.ts` `rosterInvocationIdsOf`, and the pair `epoch` belongs to.
        expect(store.liveSession(ran.sessionId).invocationThreads.size).toBe(0);
        expect(rows.map(identityOf)).toEqual([
            { invocation_id: '1', invocation_ids: ['1'], epoch: HARNESS_PROCESS_EPOCH },
            { invocation_id: '2', invocation_ids: ['2'], epoch: HARNESS_PROCESS_EPOCH }
        ]);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
});

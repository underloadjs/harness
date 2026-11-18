// W19 (2026-11-17), V5 DEFECT 2 — THE ROSTER SCAN DISCRIMINATES THE RUN IT IS ASKED ABOUT
//
// THE DEFECT. `SessionStore.noteInvocationThread` is the ONLY witness for a delegated child's
// conversation: no frame carries a CONVERSATION id, so the recorder scans the runtime roster
// (`session.harness.threads()`) for the record wearing the invocation id its `start` frame just
// reported, and records `invocation → conversation`. The scan took the FIRST record wearing the
// BARE id. A roster record restored from a process that has ENDED still carries the id that
// process minted — `runSequence` restarts with the process (`../harness.ts:8462`) and a restore
// raises it only from `core.agentResults[].sequence` (`../harness.ts:14838`) — so the dead
// generation's record out-ranked the live run's, and the join was written for the wrong
// conversation. Measured on the scenario below with the discrimination disabled: the post-restart
// turn's delegated row rendered `agentLabel: 'WE1', threadId: 'thread-2'`, the DEAD child's name
// and conversation, instead of `WE2` / `thread-4`. The same shape is in the reference artifact
// (`Temp/orch-plan/w16/fold.ts` measured `15 → thread-14` while `15` named `thread-13`).
//
// THE RULE NOW (`../server/sessions.ts:11574` + `../shared/run-identity.ts` `isRunEpochMismatch`):
// a roster record whose epoch is KNOWN and DIFFERENT is a different run, so the slot is skipped and
// the scan keeps looking — the live record of the same bare id is later in the roster, and finding
// it is the whole point of continuing. Either side naming NO epoch stays PERMISSIVE, deliberately:
// refusing it would strip the join from every pre-change document, and a legacy conversation would
// lose its label rather than gain a discriminator.
//
// WHAT IS PINNED HERE (a real run, then a document-and-journal tamper that states the restart, then
// a store rebuilt from those files — the `./labels.test.ts` J1-J3 machinery):
//   D1 — a roster record of a DEAD ledger generation cannot claim the live run's join. The live
//        root and the live child each get their OWN entry, the pre-restart turn still resolves to
//        the pre-restart conversations, and every id that reaches a client is BARE;
//   D2 — THE DOCUMENTED RESIDUAL: an epoch-less roster record still claims a new run of the same
//        bare id, and nothing on that record can tell the two runs apart. Pinned so the limit is a
//        named case, not an accident;
//   D3 — a document with no epoch anywhere (every file on disk today) keeps its join, its rows and
//        its roster exactly as before this change.
//
// W26 (2026-11-17) adds the WIRE half of the same three scenarios. D1-D3 read the store's own view
// (`store.get()` / the persisted document); what a CLIENT reads is the roster PAGE
// (`./api-reads.ts` `threadRowOf` → `./harness.swagger.yaml` `ThreadSummary`), and W22 had published
// `epoch` there while the row still carried no invocation id — a process token with nothing beside it.
// W26 put `invocation_id`/`invocation_ids` on the row, so the pair is now checkable on the wire:
//   D4 — after a restart, a post-restart row carries `epoch` BESIDE its `invocation_id`, and the two
//        generations that share the bare ids `1` and `2` are separated by that token ALONE; every id on
//        the page is BARE (the page is transcript-free by contract, so a single NUL in its JSON would be a
//        run key that leaked out of the server);
//   D5 — an epoch-less document (D2's stripped records, D3's whole document) emits NO `epoch` key on any
//        row, still names its runs, and keeps every id bare. The live half of a D2 document — records the
//        tamper did not strip — does carry it, pinned in the same read.
//
// `HARNESS_PROCESS_EPOCH` is a random token per process AND per module registry, i.e. one per test
// file, so every expectation here is written against the imported constant; `DEAD` is a literal,
// standing for a generation that has ended.
//
// Cross-references: ../server/sessions.ts `noteInvocationThread` / `labelJoinsOf`,
// ../shared/run-identity.ts, ./labels.test.ts (same tamper machinery for the label authority),
// ./persistence-test-helpers.ts (the shard paths this file rewrites), ./api-reads.ts `threadRowOf` +
// ./api-thread-roster-invocation-ids.test.ts (the row shape D4/D5 read over HTTP),
// ../frontend/ui/thread-transcript-run-join.test.ts F5/F7 (the client join these fields feed).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessStreamEvent } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { HarnessPersistence } from './persistence';
import { harnessSessionFileOf, readPersistedDocument, writePersistedDocument } from './persistence-test-helpers';
import { SessionStore } from './sessions';
import type { SessionSnapshot } from './protocol';
// The run-key rule, so the fixture states join keys with the SAME helper the recorder writes with.
import { invocationRunKeyOf } from './protocol';
import { HARNESS_PROCESS_EPOCH } from '../core/agent-limits';
// W26 (2026-11-17): the WIRE plane. D1-D3 read `store.get()` and the persisted document; D4/D5 read the
// same session through the canonical roster route, because that page is the document the client's
// transcript join is built from (`../frontend/view-shell.ts` `getRawSession`).
import { createHarnessApi } from './api';
import type { HarnessApiRequest, HarnessApiResult } from './api';

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'super-secret-key',
    model: 'scripted/test'
};

// The generation of a process that has already ended.
const DEAD = 'epoch-dead-process';

// `instruct` (code IT) delegates once to `workspace` (code WE) — the two-code fixture of
// ./labels.test.ts:147, copied so this file states its own expectations without a cross-test import.
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
            entry: 'instruct',
            ranks: { instruct: 'A', workspace: 'B' },
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

afterEach(() => {
    vi.restoreAllMocks();
});

// One queued task (a fresh host conversation) awaited to its terminal state.
const submit = async (store: SessionStore, id: string, prompt: string) => {
    const task = await store.enqueue(id, prompt, undefined, undefined, undefined);

    await task.settled;
    await store.waitForIdle(id);

    return task;
};

// The join exactly as the durable record states it: every `[run key → conversation]` entry, as
// [id, epoch] pairs. This is the fact `noteInvocationThread` writes, so it is the fact the defect
// moved. The separator is asserted through the same helper that wrote the key.
const joinOf = (root: string): [string, string | null][] => {
    const document = readPersistedDocument(root) as { sessions: { invocationThreads?: Record<string, string> }[] };
    const stored = document.sessions[0]?.invocationThreads ?? {};

    return Object.entries(stored).map(
        ([runKey, threadId]) =>
            [`${runKey.split('\0')[0]}:${threadId}`, runKey.includes('\0') ? runKey.split('\0')[1] : null] as [
                string,
                string | null
            ]
    );
};

// One turn's rows exactly as the display surface publishes them (./labels.test.ts:740).
const sectionsOf = (store: SessionStore, id: string, turnId: string) =>
    (store.turnProjector(id, turnId)?.display().sections ?? []).map((section) => ({
        agent: section.agent,
        agentLabel: section.agentLabel,
        ...(section.invocationId === undefined ? {} : { invocationId: section.invocationId }),
        ...(section.threadId === undefined ? {} : { threadId: section.threadId })
    }));

// The roster's view as a client sees it: `[label, latest id, every id]` — all BARE ids, never the
// composite key (`./protocol.ts` `invocationIdOfRunKey`).
const rosterOf = (snapshot: SessionSnapshot) =>
    (snapshot.threads ?? []).map((thread) => [thread.label, thread.invocationId, thread.invocationIds]);

// ---------------------------------------------------------------------------
// W26 (2026-11-17) — THE WIRE PLANE (D4/D5/D6)
// ---------------------------------------------------------------------------

const apiOf = (store: SessionStore) =>
    createHarnessApi({
        store,
        defaults: { baseURL: SETTINGS.baseURL, model: SETTINGS.model, hasApiKey: true },
        registry: createHarnessRegistry([instructPreset()])
    });

const callApi = async (store: SessionStore, pathname: string): Promise<Record<string, any>> => {
    const result: HarnessApiResult = await (
        apiOf(store) as unknown as (request: HarnessApiRequest) => Promise<HarnessApiResult>
    )({
        method: 'GET',
        pathname,
        mount: '/v1/harness',
        readBody: async <T>() => ({}) as T
    });

    if (result.kind !== 'json') throw new Error(`expected a json result, got ${result.kind}`);

    return result.body as Record<string, any>;
};

// The roster EXACTLY as the REST page publishes it (`./api.ts` `getSessionThreads` → `./api-reads.ts`
// `threadRowOf`): snake_case, transcript-free, and — since W26 — carrying the identity block
// `invocation_id` / `invocation_ids` / `epoch`. This is the document `../frontend/view-shell.ts`
// `getRawSession` builds the transcript dialog and the JSON export from, so a fact that only exists on
// `store.get()` proves nothing about what the client can key by.
const threadPageOf = (store: SessionStore, id: string): Promise<Record<string, any>> =>
    callApi(store, `/v1/harness/sessions/${id}/threads`);

// One row's whole identity block, in wire spelling. `epoch` reports its token when the row names one and
// the literal `ABSENT_EPOCH` when the KEY does not exist — the two are different states of the contract and
// a test must not be able to satisfy this by emitting an empty string.
const ABSENT_EPOCH = '<no epoch key>';

const identityOf = (row: Record<string, any>): (string | string[] | undefined)[] => [
    row.label,
    row.invocation_id,
    row.invocation_ids,
    Object.hasOwn(row, 'epoch') ? row.epoch : ABSENT_EPOCH
];

// The journal is the event stream a restart replays, and on restore it WINS over the document's
// `turns[].events` (`./sessions.ts:6363-6368`): the generation a restored conversation speaks about
// is the generation its JOURNAL lines name. A tamper that rewrote only the document would leave the
// projector reading current-generation frames over a dead-generation join. `epoch: null` removes the
// field, which is what every journal on disk today looks like.
const rewriteJournalEpochs = (root: string, sessionId: string, epoch: string | null): void => {
    const file = path.join(path.dirname(harnessSessionFileOf(root, sessionId)), 'events.jsonl');

    const lines = fs.readFileSync(file, 'utf8').split('\n');

    fs.writeFileSync(
        file,
        lines
            .map((line) => {
                if (line.trim().length === 0) return line;

                const record = JSON.parse(line) as Record<string, any>;
                const thread = record?.event?.thread;

                if (thread === undefined) return line;

                if (epoch === null) delete thread.epoch;
                else thread.epoch = epoch;

                return JSON.stringify(record);
            })
            .join('\n'),
        'utf8'
    );
};

// THE RESTART, stated as files. Before the tamper, one process has run invocation `1` (root, `IT1`,
// `thread-1`) and invocation `2` (its delegated child, `WE1`, `thread-2`). The tamper says that
// process has ENDED and its work is history:
//   * every recorded FRAME names the dead generation, so the projector resolves those rows by their
//     own run keys — exactly how a restarted process reads a file an older process wrote;
//   * the persisted JOIN is re-keyed to that generation (the keys the dead process wrote);
//   * the roster rows carry that generation beside their invocation id — the pair `markThreadEpoch`
//     writes (`../types/index.ts` `HarnessThreadRecord.epoch`);
//   * `core.agentResults` is emptied, because `runSequence` is raised ONLY from those rows
//     (`../harness.ts:14838`). With them gone, the reading process re-mints `1` and `2` — the
//     recycling the defect is about, and an ordinary consequence of retention.
// `stripRecordEpoch` is D2: rows from BEFORE the field existed, i.e. no epoch at all.
const writeDeadGenerationFiles = (root: string, sessionId: string, stripRecordEpoch: boolean): void => {
    const document = readPersistedDocument(root) as {
        sessions: {
            invocationThreads?: Record<string, string>;
            turns?: { events?: Record<string, any>[] }[];
            core?: { threads?: Record<string, any>[]; agentResults?: unknown[] };
        };
    };

    for (const record of document.sessions) {
        if (record.invocationThreads !== undefined) {
            record.invocationThreads = Object.fromEntries(
                Object.entries(record.invocationThreads).map(([runKey, threadId]) => [
                    invocationRunKeyOf(runKey.split('\0')[0], DEAD),
                    threadId
                ])
            );
        }

        for (const turn of record.turns ?? []) {
            for (const event of turn.events ?? []) {
                if (event.thread !== undefined) event.thread.epoch = DEAD;
            }
        }

        for (const thread of record.core?.threads ?? []) {
            if (thread.invocationId === undefined) continue;

            if (stripRecordEpoch) delete thread.epoch;
            else thread.epoch = DEAD;
        }

        if (record.core !== undefined) record.core.agentResults = [];
    }

    rewriteJournalEpochs(root, sessionId, DEAD);
    writePersistedDocument(root, document);
};

describe('the roster scan discriminates the run it is asked about', () => {
    it("refuses a dead generation's slot and binds the live conversation (D1)", async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 'w19-epoch-discriminate-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore(instructPreset(), persistence);
        const id = (await store.create('instruct')).id;

        const first = await submit(store, id, 'delegate please');
        const afterFirst = store.get(id);

        // The precondition: one process, two conversations, two runs (`1` and `2`), each with its own
        // join entry keyed by its OWN run.
        expect(first.turn.threadLabel).toBe('IT1');
        expect(rosterOf(afterFirst)).toEqual([
            ['IT1', '1', ['1']],
            ['WE1', '2', ['2']]
        ]);
        expect(joinOf(root)).toEqual([
            [`1:thread-1`, HARNESS_PROCESS_EPOCH],
            [`2:thread-2`, HARNESS_PROCESS_EPOCH]
        ]);

        store.dispose();

        writeDeadGenerationFiles(root, id, false);

        // THE RESTART, and a NEW conversation whose root run re-mints `1` and whose child re-mints `2`.
        const reloaded = createStore(instructPreset(), persistence, persistence.load());
        const second = await submit(reloaded, id, 'after the restart');
        const live = reloaded.get(id);

        expect(second.turn.threadLabel).toBe('IT2');

        // THE JOIN. Each of the four RUNS owns an entry: the dead generation keeps the two it wrote
        // (the fix does not rewrite history) and the live generation gets its own two — for the child
        // that is the whole defect, because the live child's `2` is the dead child's `2`.
        expect(joinOf(root)).toEqual([
            ['1:thread-1', DEAD],
            ['2:thread-2', DEAD],
            ['1:thread-3', HARNESS_PROCESS_EPOCH],
            ['2:thread-4', HARNESS_PROCESS_EPOCH]
        ]);

        // The roster states each conversation's own ids, and every one of them is BARE: the composite
        // run key never crosses the wire.
        expect(rosterOf(live)).toEqual([
            ['IT1', '1', ['1']],
            ['WE1', '2', ['2']],
            ['IT2', '1', ['1']],
            ['WE2', '2', ['2']]
        ]);

        // The rows a reader gets. The pre-restart turn keeps ITS conversations on ITS rows, and the
        // post-restart turn belongs to the post-restart conversations — not to `IT1`/`WE1`, whose
        // records wore the same two ids. With the discrimination disabled, the last row here is the one
        // that breaks: `agentLabel: 'WE1'`, `threadId: 'thread-2'`.
        expect(sectionsOf(reloaded, id, first.turn.id)).toEqual([
            { agent: 'instruct', agentLabel: 'IT1', invocationId: '1', threadId: 'thread-1' },
            { agent: 'workspace', agentLabel: 'WE1', invocationId: '2', threadId: 'thread-2' }
        ]);
        expect(sectionsOf(reloaded, id, second.turn.id)).toEqual([
            { agent: 'instruct', agentLabel: 'IT2', invocationId: '1', threadId: 'thread-3' },
            { agent: 'workspace', agentLabel: 'WE2', invocationId: '2', threadId: 'thread-4' }
        ]);

        reloaded.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('accepts an epoch-less roster record, which is the documented residual (D2)', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 'w19-epoch-residual-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore(instructPreset(), persistence);
        const id = (await store.create('instruct')).id;

        await submit(store, id, 'delegate please');

        store.dispose();

        // The same restart with one thing missing: the roster rows predate the field, so the dead
        // conversation's record carries `invocationId: '1'` and NOTHING that says which process minted
        // it. `isRunEpochMismatch` is one-sided by contract — `undefined` on either side means "the
        // producer said nothing", not "this is another run".
        writeDeadGenerationFiles(root, id, true);

        const reloaded = createStore(instructPreset(), persistence, persistence.load());
        const second = await submit(reloaded, id, 'after the restart');

        expect(second.turn.threadLabel).toBe('IT2');

        // THE RESIDUAL, stated exactly: the scan takes the FIRST roster record wearing the bare id —
        // the dead generation's conversation — for BOTH recycled ids, so the live generation's entries
        // name the dead conversations. The live runs are still answerable, because a conversation's OWN
        // record carries its id (that is what the roster and the fold read): the last line below is the
        // proof, and it is identical to D1's. What the residual costs is the durable join only.
        expect(joinOf(root)).toEqual([
            ['1:thread-1', DEAD],
            ['2:thread-2', DEAD],
            ['1:thread-1', HARNESS_PROCESS_EPOCH],
            ['2:thread-2', HARNESS_PROCESS_EPOCH]
        ]);

        // The observable cost, on the row the model reads: the live child's run is displayed as the
        // DEAD child's conversation. The live root is fine — its own record binds the live run key
        // exactly — which is why the residual is confined to a conversation whose join came from the
        // roster scan, i.e. a delegated child.
        expect(sectionsOf(reloaded, id, second.turn.id)).toEqual([
            { agent: 'instruct', agentLabel: 'IT2', invocationId: '1', threadId: 'thread-3' },
            { agent: 'workspace', agentLabel: 'WE1', invocationId: '2', threadId: 'thread-2' }
        ]);

        expect(rosterOf(reloaded.get(id))).toEqual([
            ['IT1', '1', ['1']],
            ['WE1', '2', ['2']],
            ['IT2', '1', ['1']],
            ['WE2', '2', ['2']]
        ]);

        reloaded.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('keeps a wholly epoch-less document resolving as it did before (D3)', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 'w19-epoch-legacy-doc-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore(instructPreset(), persistence);
        const id = (await store.create('instruct')).id;
        const first = await submit(store, id, 'delegate please');

        store.dispose();

        // A pre-change document: the join keyed by BARE ids, no epoch on any frame (journal INCLUDED)
        // and none on any roster row. This is every file on disk today.
        const document = readPersistedDocument(root) as {
            sessions: {
                invocationThreads?: Record<string, string>;
                turns?: { events?: Record<string, any>[] }[];
                core?: { threads?: Record<string, any>[] };
            };
        };

        for (const record of document.sessions) {
            if (record.invocationThreads !== undefined) {
                record.invocationThreads = Object.fromEntries(
                    Object.entries(record.invocationThreads).map(([runKey, threadId]) => [
                        runKey.split('\0')[0],
                        threadId
                    ])
                );
            }

            for (const turn of record.turns ?? []) {
                for (const event of turn.events ?? []) delete event.thread?.epoch;
            }

            for (const thread of record.core?.threads ?? []) delete thread.epoch;
        }

        rewriteJournalEpochs(root, id, null);
        writePersistedDocument(root, document);

        const legacy = createStore(instructPreset(), persistence, persistence.load());

        // Same rows, same conversations, same names — the bare-id door, unchanged.
        expect(sectionsOf(legacy, id, first.turn.id)).toEqual([
            { agent: 'instruct', agentLabel: 'IT1', invocationId: '1', threadId: 'thread-1' },
            { agent: 'workspace', agentLabel: 'WE1', invocationId: '2', threadId: 'thread-2' }
        ]);
        expect(rosterOf(legacy.get(id))).toEqual([
            ['IT1', '1', ['1']],
            ['WE1', '2', ['2']]
        ]);
        expect(joinOf(root)).toEqual([
            ['1:thread-1', null],
            ['2:thread-2', null]
        ]);

        legacy.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    // W26 (2026-11-17) — THE SAME THREE SCENARIOS, READ AS A CLIENT READS THEM.
    it('publishes the epoch beside the invocation id on the roster page, in both generations (D4)', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 'w26-epoch-wire-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore(instructPreset(), persistence);
        const id = (await store.create('instruct')).id;

        await submit(store, id, 'delegate please');
        store.dispose();

        // D1's restart: the dead generation owns its ids AND its records' epoch, so the reading process
        // re-mints `1`/`2` for NEW conversations and the collision is real on disk.
        writeDeadGenerationFiles(root, id, false);

        const reloaded = createStore(instructPreset(), persistence, persistence.load());

        await submit(reloaded, id, 'after the restart');

        const page = await threadPageOf(reloaded, id);
        const rows = page.items as Record<string, any>[];

        // THE PAIR, ON THE WIRE, IN BOTH GENERATIONS. `1` names TWO conversations and `2` names two more, and
        // the only fact on a row that says which RUN its id belongs to is `epoch`, sitting beside it — which
        // is exactly the pairing `./api-reads.ts` `threadRowOf` states (`epoch` travels with `invocation_id`
        // and never ahead of it). Before W26 this page carried the token with NO id beside it, so the client
        // that reads it (`../frontend/view-shell.ts` `getRawSession`: the transcript dialog, the JSON export)
        // had a process and nothing to pair it with.
        expect(rows.map(identityOf)).toEqual([
            ['IT1', '1', ['1'], DEAD],
            ['WE1', '2', ['2'], DEAD],
            ['IT2', '1', ['1'], HARNESS_PROCESS_EPOCH],
            ['WE2', '2', ['2'], HARNESS_PROCESS_EPOCH]
        ]);

        // The page and the snapshot agree conversation for conversation (D1's `rosterOf` pin): the identity
        // block is one projection, not a per-route invention, so the answer cannot depend on which read the
        // client made.
        expect(
            rows.map((row) => [
                row.id,
                row.label,
                row.invocation_id,
                row.invocation_ids,
                row.epoch === DEAD ? DEAD : 'live'
            ])
        ).toEqual([
            ['thread-1', 'IT1', '1', ['1'], DEAD],
            ['thread-2', 'WE1', '2', ['2'], DEAD],
            ['thread-3', 'IT2', '1', ['1'], 'live'],
            ['thread-4', 'WE2', '2', ['2'], 'live']
        ]);
        expect(rosterOf(reloaded.get(id))).toEqual([
            ['IT1', '1', ['1']],
            ['WE1', '2', ['2']],
            ['IT2', '1', ['1']],
            ['WE2', '2', ['2']]
        ]);

        // BARE, MEASURED OVER THE WHOLE RESPONSE. A roster page carries NO messages by contract, so the only
        // place a composite could hide is an id field; scanning the serialized page (envelope included) is
        // therefore a complete check that no run key `id\0epoch` escaped the server
        // (`../shared/run-identity.ts` keeps it private, `./protocol.ts` `invocationIdOfRunKey` is the strip).
        const serialized = JSON.stringify(page);

        expect(serialized.includes('\u0000')).toBe(false);
        // The dead generation's token IS on the wire (not an internal join detail), and it is the only fact
        // that separates the two rows reporting `1`. Every id stays bare: no row answers `1\0DEAD`.
        expect(serialized.includes(DEAD)).toBe(true);

        for (const row of rows) {
            expect(String(row.invocation_id).includes('\u0000')).toBe(false);

            for (const invocationId of row.invocation_ids as string[])
                expect(invocationId.includes('\u0000')).toBe(false);
        }

        reloaded.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('emits no epoch key for an epoch-less record while its live successor emits one (D5)', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 'w26-epoch-less-record-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore(instructPreset(), persistence);
        const id = (await store.create('instruct')).id;

        await submit(store, id, 'delegate please');
        store.dispose();

        // D2's document: the pre-restart records carry an invocation id and NOTHING that names a process
        // (`stripRecordEpoch: true`), which is every conversation written before the field existed.
        writeDeadGenerationFiles(root, id, true);

        const reloaded = createStore(instructPreset(), persistence, persistence.load());

        await submit(reloaded, id, 'after the restart');

        const rows = (await threadPageOf(reloaded, id)).items as Record<string, any>[];

        // THE RULE, ONE ROW AT A TIME: `epoch` is emitted exactly when the record PAIRS its id with a process,
        // so the two stripped rows carry the id and NO epoch key at all, while the two rows the live process
        // wrote carry both. An empty string here would be a third state the contract does not have.
        expect(rows.map(identityOf)).toEqual([
            ['IT1', '1', ['1'], ABSENT_EPOCH],
            ['WE1', '2', ['2'], ABSENT_EPOCH],
            ['IT2', '1', ['1'], HARNESS_PROCESS_EPOCH],
            ['WE2', '2', ['2'], HARNESS_PROCESS_EPOCH]
        ]);
        expect(rows.slice(0, 2).map((row) => Object.hasOwn(row, 'epoch'))).toEqual([false, false]);

        // And the cost of D2's residual, visible on the row: the live conversations' join entries name the
        // DEAD conversations (`./sessions.ts` `noteInvocationThread` is one-sided when the record says
        // nothing), so `thread-3`/`thread-4` report their runs from the RECORD SLOT alone — the union
        // `./api-reads.ts` `rosterInvocationIdsOf` performs. Without it these two rows would answer
        // "no runs recorded", and the transcript join would never see them as claimants of `1`/`2`.
        const joins = reloaded.liveSession(id).invocationThreads;

        // The D2 residual, stated as entries: four RUNS, four keys, and the two live runs' keys bound to the
        // DEAD conversations because a record that names no epoch cannot be refused
        // (`isRunEpochMismatch` is one-sided). Pinned by lookup rather than by sort order: the epoch token is
        // `Date.now().toString(36)`-prefixed, so a literal sort order would be a clock dependency.
        expect(joins.size).toBe(4);
        expect(joins.get(invocationRunKeyOf('1', DEAD))).toBe('thread-1');
        expect(joins.get(invocationRunKeyOf('2', DEAD))).toBe('thread-2');
        expect(joins.get(invocationRunKeyOf('1', HARNESS_PROCESS_EPOCH))).toBe('thread-1');
        expect(joins.get(invocationRunKeyOf('2', HARNESS_PROCESS_EPOCH))).toBe('thread-2');
        expect(joins.get(invocationRunKeyOf('1', undefined))).toBeUndefined();

        reloaded.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('names the runs of a wholly epoch-less document and emits no epoch key on any row (D6)', async () => {
        const root = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 'w26-epoch-legacy-wire-'));
        const persistence = new HarnessPersistence(root);
        const store = createStore(instructPreset(), persistence);
        const id = (await store.create('instruct')).id;

        await submit(store, id, 'delegate please');
        store.dispose();

        // D3's whole-document strip — bare join keys, no epoch on any frame or any record: every file on disk
        // written before this field existed. Same tamper, same shape, written the same way so the two files
        // cannot drift.
        const document = readPersistedDocument(root) as {
            sessions: {
                invocationThreads?: Record<string, string>;
                turns?: { events?: Record<string, any>[] }[];
                core?: { threads?: Record<string, any>[] };
            };
        };

        for (const record of document.sessions) {
            if (record.invocationThreads !== undefined) {
                record.invocationThreads = Object.fromEntries(
                    Object.entries(record.invocationThreads).map(([runKey, threadId]) => [
                        runKey.split('\u0000')[0],
                        threadId
                    ])
                );
            }

            for (const turn of record.turns ?? []) {
                for (const event of turn.events ?? []) delete event.thread?.epoch;
            }

            for (const thread of record.core?.threads ?? []) delete thread.epoch;
        }

        rewriteJournalEpochs(root, id, null);
        writePersistedDocument(root, document);

        const legacy = createStore(instructPreset(), persistence, persistence.load());
        const page = await threadPageOf(legacy, id);
        const rows = page.items as Record<string, any>[];

        // A legacy client LOSES NOTHING and GAINS the ids: the runs it never had a way to name on this plane
        // are now on the row, and the epoch key simply does not appear.
        expect(rows.map(identityOf)).toEqual([
            ['IT1', '1', ['1'], ABSENT_EPOCH],
            ['WE1', '2', ['2'], ABSENT_EPOCH]
        ]);
        expect(rows.map((row) => Object.hasOwn(row, 'epoch'))).toEqual([false, false]);
        expect(JSON.stringify(page).includes('\u0000')).toBe(false);

        legacy.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
});

// v2 ON-DISK LAYOUT — one index, one record per session, one file per conversation.
//
// WHAT THIS FILE PINS (and why each pin is phrased that way)
// ----------------------------------------------------------
// The split is a SERIALIZATION change: `HarnessPersistence.load()`/`save()` and the
// in-memory `HarnessDatabase` are supposed to be untouched, so every pin here is either
// (a) the bytes of one shard, (b) the SHAPE of the tree, or (c) an identity claim about
// `load()` — "the graph you get back is the graph the single-file model produced", which is
// the property the rest of the package depends on and the one a shard refactor can break
// silently (a re-sorted thread list, a transcript attached to the wrong row, an optional
// key that stopped being optional).
//
// Assertions are EXACT: full payload strings for shards (`JSON.stringify` of the expected
// document — the writer is compact, ./persistence.ts `serializeHarnessShard`), full trees
// for layout, full objects for round trips. Write-skipping is pinned by INODE, not by time:
// a commit is staging+rename, so a rewritten file always gets a new inode while a skipped
// file keeps its exact one. That is exact where an `mtimeMs` comparison would be a race
// (two saves in one tick can share a timestamp) and it is the claim the rule actually
// makes — "the shard was not opened", not "it looks newer".
//
// THE CLOCK IS PINNED wherever bytes are compared. `savedAt` is the only wall-clock value
// in the layout (it lives in `index.json` and nowhere else), so an unpinned clock would put
// a different number in every expected payload.
//
// WHY THE PATH HELPERS ARE LOCAL
// ------------------------------
// `./persistence-test-helpers.ts` is the shared reader the suites that only READ use. This
// file writes bytes of its own (hand-corrupted shards, a hand-made v1 file) and must not
// move when that helper moves, so it spells its own paths — deliberately duplicated,
// deliberately independent of the writer under test.
//
// Layer split: everything under "shard bytes"/"load()"/"save()" drives `HarnessPersistence`
// with a HAND-BUILT database (no provider, no harness, no store), which is what makes the
// byte assertions stable and fast. The last two describes drive a real `SessionStore` over
// a scripted preset, because three claims are only true at that level: the transcripts are
// real, `events.jsonl` coexists with `threads/`, and a torn shard reaches the EXISTING
// tolerance (`tolerateThreadTranscripts` → `invalidThreads`, ./sessions.ts:3811-3927)
// instead of dropping the session.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessStream, HarnessStreamEvent } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry, createToolCatalogue, createWebSearchCatalogueEntry } from './harnesses';
import { createHarnessRuntime } from './runtime';
import type { HarnessRuntime } from './runtime';
import type { HarnessDescriptor } from './protocol';
// The snapshot version the loader asserts a session's `core` carries
// (./persistence.ts `requireCoreSnapshotVersion` -> ../core/snapshot.ts
// `HARNESS_SNAPSHOT_VERSION`). It is imported rather than written as a literal so this file
// cannot silently start feeding the fixture a stale snapshot the day the kernel bumps.
import { HARNESS_SNAPSHOT_VERSION } from '../core/snapshot';
import {
    HARNESS_DATABASE_DIRECTORY,
    HARNESS_DATABASE_FILE,
    HARNESS_DATABASE_VERSION,
    HARNESS_INDEX_FILE,
    HARNESS_MISSING_THREAD_TRANSCRIPT,
    HARNESS_SESSION_FILE,
    HARNESS_THREAD_DIRECTORY,
    HarnessPersistence,
    HarnessPersistenceError,
    readHarnessDatabase,
    serializeHarnessDatabase,
    serializeHarnessShard,
    writeHarnessShardFile
} from './persistence';
import type {
    HarnessDatabase,
    HarnessPresetRecord,
    HarnessSessionRecord,
    HarnessShardUnit
} from './persistence';

// ---------------------------------------------------------------------------
// Temp roots (mirrors ./persistence.test.ts: one fresh root per test, all under the
// repo-root Temp/ scratch area)
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const roots: string[] = [];

const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-shards-${label}-`));

    roots.push(root);

    return root;
};

// `<root>/harness`, resolved the way `HarnessPersistence` resolves it.
const harnessDir = (root: string): string => path.join(path.resolve(root), HARNESS_DATABASE_DIRECTORY);

const indexFile = (root: string): string => path.join(harnessDir(root), HARNESS_INDEX_FILE);

const sessionFile = (root: string, sessionId: string): string =>
    path.join(harnessDir(root), 'sessions', sessionId, HARNESS_SESSION_FILE);

const threadFile = (root: string, sessionId: string, threadId: string): string =>
    path.join(harnessDir(root), 'sessions', sessionId, HARNESS_THREAD_DIRECTORY, `${threadId}.json`);

const journalFile = (root: string, sessionId: string): string =>
    path.join(harnessDir(root), 'sessions', sessionId, 'events.jsonl');

const readJson = (file: string): Record<string, any> => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;

// Every file below `<root>/harness`, as sorted slash-separated relative paths — the
// layout claim in one value, so an extra directory or a stray file fails visibly.
const treeOf = (root: string): string[] => {
    const directory = harnessDir(root);

    if (!fs.existsSync(directory)) return [];

    const files: string[] = [];
    const walk = (current: string, prefix: string): void => {
        for (const entry of fs.readdirSync(current).sort()) {
            const full = path.join(current, entry);
            const relative = prefix.length === 0 ? entry : `${prefix}/${entry}`;

            if (fs.statSync(full).isDirectory()) {
                files.push(`${relative}/`);
                walk(full, relative);
                continue;
            }

            files.push(relative);
        }
    };

    walk(directory, '');

    return files;
};

// Staging files anywhere under the tree: every shard is committed through the same
// staging + fsync + rename sequence, so a leftover can now hide one directory deeper
// than the flat v1 listing could see.
const stagingLeftovers = (root: string): string[] => treeOf(root).filter((entry) => entry.endsWith('.tmp'));

// `path -> inode`. A shard that was committed again has a NEW inode (rename replaced it);
// a shard the writer skipped has the OLD one.
const inodesOf = (root: string): Record<string, number> => {
    const directory = harnessDir(root);
    const map: Record<string, number> = {};
    const walk = (current: string, prefix: string): void => {
        for (const entry of fs.readdirSync(current).sort()) {
            const full = path.join(current, entry);
            const relative = prefix.length === 0 ? entry : `${prefix}/${entry}`;

            if (fs.statSync(full).isDirectory()) {
                walk(full, relative);
                continue;
            }

            map[relative] = fs.statSync(full).ino;
        }
    };

    walk(directory, '');

    return map;
};

// Pins `Date.now` and hands back a mover, so "the bytes changed" and "the index stamp
// moved" are calls rather than waits. Only `Date` is replaced; the store tests below still
// get real timers for their runs.
const pinClock = (start = 1_700_000_000_002): ((next: number) => void) => {
    let value = start;

    vi.spyOn(Date, 'now').mockImplementation(() => value);

    return (next: number) => {
        value = next;
    };
};

afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The hand-built database (no harness, no store — just the record shape)
// ---------------------------------------------------------------------------
//
// A record is a `HarnessSessionRecord`; `core` must carry the snapshot version THIS build
// reads (`readSessionRecord` -> `requireCoreSnapshotVersion`, ./persistence.ts), and the
// loader hands the rest of the snapshot to `harness.restore()` as-is, so a minimal core with
// the right version is enough to pin WHERE its thread transcripts are stored — which is the
// whole subject of this file. The real-core version of the same claim is the store describe at
// the bottom; the stale-version case is its own test below ("refuses a session whose `core` is
// an older snapshot").
const PRESET: HarnessPresetRecord = {
    name: 'one',
    title: 'one',
    description: 'one scripted preset',
    requiresEndpoint: false,
    entry: 'one',
    ranks: { one: 'A' },
    agents: ['one'],
    tools: [],
    builtin: true,
    editable: true
};

const DEFINITION: HarnessDescriptor = { ...PRESET };

// One thread row, exactly as `harness.snapshot()` emits it: identity fields first, and the
// transcript LAST. Each transcript names its own thread, so a transcript attached to the
// wrong row cannot pass.
const threadRow = (id: string, sequence: number): Record<string, unknown> => ({
    id,
    agent: 'one',
    status: 'idle',
    sequence,
    messages: [{ role: 'user', content: `prompt of ${id}`, messageId: `m-${id}` }]
});

const EXPECTED_ROWS = ['thread-3', 'thread-11', 'thread-2'];

// Non-alphabetical on purpose, in BOTH dimensions: a writer that sorted sessions by id, or
// re-sorted thread rows by shard file name, would pass an alphabetical fixture and fail this
// one (file-name order puts `thread-11` before `thread-2`).
const SESSION_B = 'ses-b';
const SESSION_A = 'ses-a';

const sessionOf = (
    id: string,
    threads: Record<string, unknown>[],
    extra: Partial<HarnessSessionRecord> = {}
): HarnessSessionRecord =>
    ({
        id,
        harness: 'one',
        preset: PRESET,
        definition: DEFINITION,
        settings: { baseURL: 'http://scripted.invalid/v1', model: 'scripted/test' },
        status: 'idle',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_001,
        turns: [],
        queue: [],
        core: { version: HARNESS_SNAPSHOT_VERSION, agents: { one: { messages: [] } }, threads }
    }) as unknown as HarnessSessionRecord;

// Two sessions, five conversations between them, in live-map insertion order.
const fixtureOf = (sessions: HarnessSessionRecord[] = [
    sessionOf(SESSION_B, EXPECTED_ROWS.map((id, index) => threadRow(id, index + 1))),
    sessionOf(SESSION_A, [threadRow('thread-1', 1)])
]): HarnessDatabase => ({
    version: HARNESS_DATABASE_VERSION,
    savedAt: 1_700_000_000_002,
    registry: [PRESET],
    sessions
});

// ---------------------------------------------------------------------------
// R1/R2 — the bytes of each shard
// ---------------------------------------------------------------------------

describe('v2 shard bytes (R1/R2)', () => {
    it('writes index.json plus sessions/<id>/{session.json,threads/<threadId>.json} and nothing else', () => {
        const root = tempRoot('tree');
        const persistence = new HarnessPersistence(root);

        persistence.save(fixtureOf());

        expect(treeOf(root)).toEqual([
            'index.json',
            'sessions/',
            `sessions/${SESSION_A}/`,
            `sessions/${SESSION_A}/session.json`,
            `sessions/${SESSION_A}/threads/`,
            `sessions/${SESSION_A}/threads/thread-1.json`,
            `sessions/${SESSION_B}/`,
            `sessions/${SESSION_B}/session.json`,
            `sessions/${SESSION_B}/threads/`,
            `sessions/${SESSION_B}/threads/thread-11.json`,
            `sessions/${SESSION_B}/threads/thread-2.json`,
            `sessions/${SESSION_B}/threads/thread-3.json`
        ]);

        expect(fs.readdirSync(path.join(harnessDir(root), 'sessions', SESSION_B)).sort()).toEqual([
            HARNESS_SESSION_FILE,
            HARNESS_THREAD_DIRECTORY
        ]);
        expect(stagingLeftovers(root)).toEqual([]);
    });

    it('writes only the harness-level document into index.json, with the session list in live order', () => {
        const root = tempRoot('index');
        const move = pinClock();
        const persistence = new HarnessPersistence(root);
        const database = fixtureOf();

        persistence.save(database);

        // Exact bytes, compact like every other harness file: same keys, same order, and
        // ONLY the header — no registry payloads beyond the records, no session fields.
        expect(fs.readFileSync(indexFile(root), 'utf8')).toBe(
            JSON.stringify({
                version: 2,
                savedAt: 1_700_000_000_002,
                registry: [PRESET],
                sessions: [
                    { id: SESSION_B, ordinal: 1 },
                    { id: SESSION_A, ordinal: 2 }
                ]
            })
        );

        // The ordinal is the 1-based creation position, and the array order is the live-map
        // order (`ses-b` first although it sorts last).
        expect(readJson(indexFile(root)).sessions).toEqual([
            { id: SESSION_B, ordinal: 1 },
            { id: SESSION_A, ordinal: 2 }
        ]);
        expect(readJson(indexFile(root)).version).toBe(HARNESS_DATABASE_VERSION);

        // The stamp is the index's own: moving the clock moves ONLY that file.
        const before = inodesOf(root);

        move(1_700_000_000_500);
        persistence.save(database);

        expect(readJson(indexFile(root)).savedAt).toBe(1_700_000_000_500);
        expect(inodesOf(root)['index.json']).not.toBe(before['index.json']);
        expect(inodesOf(root)[`sessions/${SESSION_B}/session.json`]).toBe(before[`sessions/${SESSION_B}/session.json`]);
    });

    it('stores each session record with no transcript on any thread row', () => {
        const root = tempRoot('session-shard');
        const move = pinClock();
        const persistence = new HarnessPersistence(root);

        persistence.save(fixtureOf());

        const stored = readJson(sessionFile(root, SESSION_B));

        // The record exactly as `sessionRecord()` produces it (same keys, same values), with
        // one difference: every `core.threads[]` row lost `messages` and nothing else.
        expect(Object.keys(stored)).toEqual([
            'id',
            'harness',
            'preset',
            'definition',
            'settings',
            'status',
            'createdAt',
            'updatedAt',
            'turns',
            'queue',
            'core'
        ]);
        expect(stored.id).toBe(SESSION_B);
        expect(stored.preset).toEqual(PRESET);
        expect(stored.settings).toEqual({ baseURL: 'http://scripted.invalid/v1', model: 'scripted/test' });
        expect(stored.core.agents).toEqual({ one: { messages: [] } });
        expect(stored.core.threads).toEqual(
            EXPECTED_ROWS.map((id, index) => ({ id, agent: 'one', status: 'idle', sequence: index + 1 }))
        );
        expect(stored.core.threads.some((row: Record<string, unknown>) => 'messages' in row)).toBe(false);

        // No envelope and no timestamp: the record IS the file, so a checkpoint of an
        // untouched session has byte-stable content for the digest gate to skip.
        const before = inodesOf(root);

        move(1_700_000_000_600);
        persistence.save(fixtureOf());

        expect(inodesOf(root)[`sessions/${SESSION_B}/session.json`]).toBe(before[`sessions/${SESSION_B}/session.json`]);
        expect(stagingLeftovers(root)).toEqual([]);
    });

    it('stores one transcript per conversation, with the version and the session beside it', () => {
        const root = tempRoot('thread-shard');
        const persistence = new HarnessPersistence(root);

        persistence.save(fixtureOf());

        for (const id of EXPECTED_ROWS) {
            expect(readJson(threadFile(root, SESSION_B, id))).toEqual({
                version: 2,
                sessionId: SESSION_B,
                id,
                messages: [{ role: 'user', content: `prompt of ${id}`, messageId: `m-${id}` }]
            });

            // Exact bytes, key order included — the recovery story of a single picked-up
            // file depends on these fields, and the writer is compact.
            expect(fs.readFileSync(threadFile(root, SESSION_B, id), 'utf8')).toBe(
                JSON.stringify({
                    version: 2,
                    sessionId: SESSION_B,
                    id,
                    messages: [{ role: 'user', content: `prompt of ${id}`, messageId: `m-${id}` }]
                })
            );
        }
    });

    it('serializes and commits a shard unit standalone (the IO worker seam)', () => {
        const root = tempRoot('unit-seam');
        const directory = path.join(harnessDir(root), 'standalone');
        const unit: HarnessShardUnit = {
            kind: 'thread',
            directory,
            sessionId: 'ses-x',
            id: 'thread-9',
            messages: [{ role: 'user', content: 'handed over', messageId: 'm-9' }]
        };

        // A worker serializes once (it needs the byte length for its frame guard) and hands
        // the payload to the writer: both calls must agree on the SAME text.
        const payload = serializeHarnessShard(unit);

        expect(payload).toBe(
            '{"version":2,"sessionId":"ses-x","id":"thread-9","messages":[{"role":"user","content":"handed over","messageId":"m-9"}]}'
        );

        writeHarnessShardFile(unit, { owner: 'process-1.42', sequence: () => 7 });

        expect(fs.readFileSync(path.join(directory, 'thread-9.json'), 'utf8')).toBe(payload);
        // The staging name carried this writer's `owner`/`sequence` and is gone: the commit
        // is a rename, and a leftover would be the failure the layout pins above watch for.
        expect(fs.readdirSync(directory)).toEqual(['thread-9.json']);

        // A thread id that cannot be a file name is refused rather than path-joined: a
        // hand-edited `../x` must not be able to write outside its directory.
        expect(() =>
            writeHarnessShardFile({ ...unit, id: '../escape' }, { owner: 'process-1.42' })
        ).toThrow(HarnessPersistenceError);

        let failure: unknown;

        try {
            writeHarnessShardFile({ ...unit, id: '../escape' }, { owner: 'process-1.42' });
        } catch (error) {
            failure = error;
        }

        expect((failure as Error).message).toContain('thread-<n>');
        expect(fs.readdirSync(directory)).toEqual(['thread-9.json']);
    });
});

// ---------------------------------------------------------------------------
// R3 — `load()` hands back the graph the single file used to hand back
// ---------------------------------------------------------------------------

describe('load() reassembles the single-file graph (R3)', () => {
    it('reloads a multi-session, multi-thread database byte-identically to the single-file model', () => {
        const root = tempRoot('round-trip');
        const move = pinClock();
        const persistence = new HarnessPersistence(root);
        const database = fixtureOf();

        persistence.save(database);

        // The v1 model of the same bytes: one document through `serializeHarnessDatabase` +
        // `readHarnessDatabase`, i.e. what every consumer of `load()` saw before the split.
        const singleFile = readHarnessDatabase(JSON.parse(serializeHarnessDatabase(database)));
        const reloaded = new HarnessPersistence(root).load();

        expect(reloaded).toBeDefined();
        expect(reloaded).toEqual(singleFile);
        // Stronger than `toEqual`: the key order of every reassembled record — header fields,
        // the record, and each thread row with its transcript back — is the one the document
        // had, so a consumer that stringifies a record (byte pins, digests, a JSON-Like hash)
        // still sees the same text.
        expect(JSON.stringify(reloaded)).toBe(JSON.stringify(singleFile));

        // Round trip is a fixed point: re-saving the reloaded graph and loading it again yields
        // the identical graph, and the shard bytes of the untouched sessions do not move at all.
        //
        // The second save goes through the SAME owner that wrote the first one, because that is
        // the state the digest gate needs: a brand-new `HarnessPersistence` has never seen the
        // bytes on disk, so its first commit rewrites every shard exactly once (the inode pin in
        // the `save()` describe covers that case). A long-lived writer — the store's own, which
        // is the whole point of the split — skips everything whose bytes it just committed.
        const before = inodesOf(root);

        move(1_700_000_000_777);
        persistence.save(reloaded!);

        const second = new HarnessPersistence(root).load();

        // The v1 model of THESE bytes at THIS instant — one document through
        // `serializeHarnessDatabase` + `readHarnessDatabase`, stamped by the same pinned clock
        // the shard commit used. `savedAt` is the only field a save re-stamps (neither v1's
        // serializer nor v2's `harnessIndexDocumentOf` mutates the graph it is handed), so the
        // fixed point has to be compared against a model built at the same tick; comparing
        // against the FIRST save's text would pin a timestamp the second save never wrote.
        const secondSingleFile = readHarnessDatabase(JSON.parse(serializeHarnessDatabase(reloaded!)));

        expect(JSON.stringify(second)).toBe(JSON.stringify(secondSingleFile));
        // Untouched session, untouched transcript: same inode, i.e. never opened for writing.
        expect(inodesOf(root)[`sessions/${SESSION_A}/session.json`]).toBe(before[`sessions/${SESSION_A}/session.json`]);
        expect(inodesOf(root)[`sessions/${SESSION_A}/threads/thread-1.json`]).toBe(
            before[`sessions/${SESSION_A}/threads/thread-1.json`]
        );
    });

    it('keeps every transcript on its own row, in the order session.json lists the rows', () => {
        const root = tempRoot('row-order');
        const persistence = new HarnessPersistence(root);

        persistence.save(fixtureOf());

        const rows = (persistence.load()!.sessions[0].core as unknown as { threads: Record<string, any>[] }).threads;

        // The array order of the record — NOT the shard-file order, which would sort
        // `thread-11` before `thread-2`.
        expect(rows.map((row) => row.id)).toEqual(EXPECTED_ROWS);
        expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3]);
        expect(rows.map((row) => row.messages)).toEqual(
            EXPECTED_ROWS.map((id) => [{ role: 'user', content: `prompt of ${id}`, messageId: `m-${id}` }])
        );
        // The row keeps its own key order and gains `messages` back at the end, which is the
        // only difference from what `snapshot()` produced.
        expect(Object.keys(rows[0])).toEqual(['id', 'agent', 'status', 'sequence', 'messages']);
        expect(persistence.load()!.sessions.map((session) => session.id)).toEqual([SESSION_B, SESSION_A]);
    });

    it('refuses a corrupt header naming index.json, and keeps the bytes', () => {
        const root = tempRoot('corrupt-index');
        const persistence = new HarnessPersistence(root);

        persistence.save(fixtureOf());
        fs.writeFileSync(indexFile(root), '{"version":2,"savedAt":1,"registry":[', 'utf8');

        let failure: unknown;

        try {
            new HarnessPersistence(root).load();
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(HarnessPersistenceError);
        expect((failure as Error).message).toContain('is not valid JSON');
        expect((failure as Error).message).toContain(indexFile(root));
        expect(fs.readFileSync(indexFile(root), 'utf8')).toBe('{"version":2,"savedAt":1,"registry":[');

        // A wrong version is refused before any field is read, with the v1 sentence.
        fs.writeFileSync(indexFile(root), JSON.stringify({ version: 999, savedAt: 0, registry: [], sessions: [] }), 'utf8');

        let versioned: unknown;

        try {
            new HarnessPersistence(root).load();
        } catch (error) {
            versioned = error;
        }

        expect((versioned as Error).message).toContain('Unsupported harness database version 999');
        expect((versioned as Error).message).toContain(HARNESS_INDEX_FILE);
    });

    it('refuses a corrupt session record naming THAT session file', () => {
        const root = tempRoot('corrupt-session');
        const persistence = new HarnessPersistence(root);

        persistence.save(fixtureOf());

        // The pristine bytes, read before anything below damages the file: the shape case at the
        // end of this test needs a record with exactly ONE wrong field, and the only honest way
        // to get one is to take what the writer produced and break one value in it.
        const pristine = readJson(sessionFile(root, SESSION_A));

        // The blast radius is the v1 one: a broken record used to sit inside the one document
        // and `readHarnessDatabase` refused the whole load. Sharding must not turn that loud
        // failure into a silently missing session, so this throws — naming the file that is
        // actually broken instead of the header.
        fs.writeFileSync(sessionFile(root, SESSION_A), '{"id":', 'utf8');

        let failure: unknown;

        try {
            new HarnessPersistence(root).load();
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(HarnessPersistenceError);
        expect((failure as Error).message).toContain('is not valid JSON');
        expect((failure as Error).message).toContain(sessionFile(root, SESSION_A));
        expect((failure as Error).message).not.toContain(indexFile(root));
        expect(fs.readFileSync(sessionFile(root, SESSION_A), 'utf8')).toBe('{"id":');

        // A structurally invalid record fails the shared validator with the v1 label, and the
        // position in `index.json` says which session it was. ONE field is wrong — everything
        // else is the bytes the writer just produced — so the message can only name that field.
        fs.writeFileSync(sessionFile(root, SESSION_A), JSON.stringify({ ...pristine, harness: 7 }), 'utf8');

        let shapedFailure: unknown;

        try {
            new HarnessPersistence(root).load();
        } catch (error) {
            shapedFailure = error;
        }

        expect((shapedFailure as Error).message).toContain('has an invalid shape or version');
        expect((shapedFailure as Error).message).toContain('sessions[1].harness must be a string.');
    });

    it('refuses a registry row still written in the retired roster vocabulary', () => {
        // THE CLEAN BREAK, durable side. `primary` + `subagents` no longer means what this build
        // reads: `subagents: []` claimed "no delegates" while the rank model states authority per
        // member, and a row whose delegation model this build cannot state must fail LOUD rather
        // than resume as a team its author never configured.
        const root = tempRoot('legacy-roster-row');
        const persistence = new HarnessPersistence(root);

        persistence.save(fixtureOf());

        // The same record, only the retired pair: the row an installation has on disk today.
        const legacyRow: Record<string, unknown> = { ...PRESET, primary: 'one', subagents: [] };

        delete legacyRow.entry;
        delete legacyRow.ranks;

        const header = readJson(indexFile(root));

        header.registry = [legacyRow];
        fs.writeFileSync(indexFile(root), JSON.stringify(header), 'utf8');

        let failure: unknown;

        try {
            new HarnessPersistence(root).load();
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(HarnessPersistenceError);
        expect((failure as HarnessPersistenceError).file).toBe(indexFile(root));
        // It names the keys it refused AND the shape it wants, so an operator can rewrite the row
        // from the message alone — the refusal is the migration guide.
        expect((failure as Error).message).toContain(
            'registry[0] was written before the rank model and carries `primary` and `subagents`.'
        );
        expect((failure as Error).message).toContain(
            'This build stores `entry` (the routing agent, one of `agents`) and `ranks` ' +
                '(agent id -> a single rank letter, "A" highest to "Z" lowest) instead'
        );
        expect((failure as Error).message).toContain('does not translate the old keys');
        // Nothing was rewritten: the bytes on disk are still the ones the operator has to fix.
        expect(fs.readFileSync(indexFile(root), 'utf8')).toContain('"subagents":[]');
    });

    it('refuses a frozen session definition still written in the retired roster vocabulary', () => {
        // The frozen definition is the executable contract the NEXT turn rebuilds from, so it
        // carries the identical refusal — and it is the row a long-lived installation is most
        // likely to still have, because a session can outlive every edit to its card.
        const root = tempRoot('legacy-roster-definition');
        const persistence = new HarnessPersistence(root);

        persistence.save(fixtureOf());

        const pristine = readJson(sessionFile(root, SESSION_A));
        const definition: Record<string, unknown> = {
            ...(pristine.definition as Record<string, unknown>),
            primary: 'one',
            subagents: []
        };

        delete definition.entry;
        delete definition.ranks;

        fs.writeFileSync(sessionFile(root, SESSION_A), JSON.stringify({ ...pristine, definition }), 'utf8');

        let failure: unknown;

        try {
            new HarnessPersistence(root).load();
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(HarnessPersistenceError);
        // The FILE is the header, not the shard: shard bytes are only parse-checked per file,
        // while the shape (and therefore the roster vocabulary) is validated once over the merged
        // graph, which is the v1 all-or-nothing outcome this layer keeps on purpose. What still
        // localises the damage is the label: the session's POSITION in `index.json` plus the field
        // path — `ses-a` is the second row, and only its frozen definition is wrong.
        expect((failure as HarnessPersistenceError).file).toBe(indexFile(root));
        expect((failure as Error).message).toContain(
            'sessions[1].definition was written before the rank model and carries `primary` and `subagents`.'
        );
        // The untouched sibling session is not blamed: its own shard still holds the new shape,
        // so the refusal is about one record even though the load fails as a whole.
        expect(readJson(sessionFile(root, SESSION_B)).definition.entry).toBe('one');
    });

    it('refuses a stored rank that is not a single letter', () => {
        // The rank VALUE rule at the durable boundary (`readRankMap` -> `isAgentRank`,
        // ../types/index.ts): a lower-case letter is what a hand-edited file looks like, and
        // accepting it would store an authority this build's ordering cannot compare.
        const root = tempRoot('legacy-rank-value');
        const persistence = new HarnessPersistence(root);

        persistence.save(fixtureOf());

        const header = readJson(indexFile(root));

        header.registry[0].ranks = { one: 'a' };
        fs.writeFileSync(indexFile(root), JSON.stringify(header), 'utf8');

        let failure: unknown;

        try {
            new HarnessPersistence(root).load();
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(HarnessPersistenceError);
        expect((failure as Error).message).toContain(
            'registry[0].ranks.one must be a single rank letter from "A" (highest) to "Z" (lowest).'
        );

        // A `ranks` that is not an object at all is the other hand-edit, and it is refused with
        // the reader's own sentence rather than a missing-key cascade.
        fs.writeFileSync(
            indexFile(root),
            JSON.stringify({ ...header, registry: [{ ...header.registry[0], ranks: ['A'] }] }),
            'utf8'
        );

        let shaped: unknown;

        try {
            new HarnessPersistence(root).load();
        } catch (error) {
            shaped = error;
        }

        expect((shaped as Error).message).toContain('registry[0].ranks must be an object.');
    });

    it('refuses a session whose `core` is an older snapshot, and keeps its shards through the next save', () => {
        // THE HALF-ACCEPT THIS BUILD MUST NOT HAVE. `definition` is already in the rank shape, so
        // the roster refusal above passes, and the ONLY fact marking this row as pre-rank is
        // `core.version` — the loader used to check it was a NUMBER and hand the snapshot to
        // `harness.restore()` unread (./persistence.ts `readSessionRecord`). The snapshot's own
        // gate (../core/snapshot.ts:1205) then fired LATER, per session, inside ./sessions.ts
        // `restoreSession`: the session left the live map (./sessions.ts:2189-2195, reported in
        // `restoreErrors`), and the store's next checkpoint (./sessions.ts:3991) read that
        // absence as "the session left the map" and DELETED its shards. Observed on a real root
        // before this guard: `session.json` gone, `threads/` gone, `events.jsonl` and the
        // directory kept — destructive on disk, loud only in the diagnostics.
        const root = tempRoot('stale-core-snapshot');
        const persistence = new HarnessPersistence(root);

        persistence.save(fixtureOf());

        // The journal is the store's file, not this layer's; it is here so the survivor tree
        // shows the whole footprint the operator can still recover.
        const journal = journalFile(root, SESSION_A);

        fs.writeFileSync(journal, `{"type":"header","v":1,"sessionId":"${SESSION_A}","createdAt":1}\n`, 'utf8');

        // ONE field moves — `core.version`, back to the snapshot this build replaced — and every
        // other byte is what the writer just produced, so the refusal can only be about the
        // snapshot the row carries. `HARNESS_SNAPSHOT_VERSION - 1` rather than a literal: the
        // row stays "one version behind this build" whatever the kernel bumps to next.
        const stale = readJson(sessionFile(root, SESSION_A));
        const staleBytes = JSON.stringify({
            ...stale,
            core: { ...(stale.core as Record<string, unknown>), version: HARNESS_SNAPSHOT_VERSION - 1 }
        });

        fs.writeFileSync(sessionFile(root, SESSION_A), staleBytes, 'utf8');

        // A FRESH instance: the reader of a RESTARTED process, which is the reader the
        // destructive flow actually reaches (the bytes were written by an earlier one). `load()`
        // is where the refusal belongs — fatal, like every other record-level shape failure
        // this layer has.
        const reader = new HarnessPersistence(root);
        let failure: unknown;

        try {
            reader.load();
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(HarnessPersistenceError);
        // The FILE it reports is the header that published the id (this layout's rule, see the
        // two roster refusals above); what localises the damage is the label — `ses-a` is the
        // second row, and only its snapshot is stale.
        expect((failure as HarnessPersistenceError).file).toBe(indexFile(root));
        expect((failure as Error).message).toContain(
            `sessions[1].core is snapshot version ${HARNESS_SNAPSHOT_VERSION - 1}, and this build reads snapshot version ${HARNESS_SNAPSHOT_VERSION}.`
        );
        // The refusal is the migration guide: it names the shard that carries the stale
        // snapshot, says nothing is translated, and gives the remedy the roster refusals give.
        // The path is spelled out here rather than derived, the way this file spells its own
        // shard paths, so the expected message cannot drift along with the module under test.
        expect((failure as Error).message).toContain(
            `The record that carries it is sessions/${SESSION_A}/${HARNESS_SESSION_FILE}`
        );
        expect((failure as Error).message).toContain('does not translate a stored snapshot');
        expect((failure as Error).message).toContain(
            're-save that session record in the new shape, or start from a fresh database root.'
        );

        // The bytes are still exactly the stale ones: a refusal never rewrites the record it
        // refused, so the operator can still read what is there.
        expect(fs.readFileSync(sessionFile(root, SESSION_A), 'utf8')).toBe(staleBytes);

        const before = inodesOf(root);

        // THE NEXT SAVE — the commit that used to do the deleting: the store dropped the refused
        // session and committed the document it had left (./sessions.ts:3991). The reader that
        // refused has NO primed footprint (the swap happens only on a successful read), so it
        // has nothing to erase, and the refused session keeps every byte it had.
        reader.save(fixtureOf([sessionOf(SESSION_B, EXPECTED_ROWS.map((id, index) => threadRow(id, index + 1)))]));

        // The complete survivor tree, in one value: the refused record, its transcript and its
        // journal are all still there next to the session the save did commit.
        expect(treeOf(root)).toEqual([
            'index.json',
            'sessions/',
            `sessions/${SESSION_A}/`,
            `sessions/${SESSION_A}/events.jsonl`,
            `sessions/${SESSION_A}/session.json`,
            `sessions/${SESSION_A}/threads/`,
            `sessions/${SESSION_A}/threads/thread-1.json`,
            `sessions/${SESSION_B}/`,
            `sessions/${SESSION_B}/session.json`,
            `sessions/${SESSION_B}/threads/`,
            `sessions/${SESSION_B}/threads/thread-11.json`,
            `sessions/${SESSION_B}/threads/thread-2.json`,
            `sessions/${SESSION_B}/threads/thread-3.json`
        ]);

        // Same INODES, so the survivors were not rewritten either — the save never opened a path
        // under `sessions/ses-a` at all (a rewrite would replace the file and move the inode).
        const after = inodesOf(root);

        expect(after[`sessions/${SESSION_A}/${HARNESS_SESSION_FILE}`]).toBe(
            before[`sessions/${SESSION_A}/${HARNESS_SESSION_FILE}`]
        );
        expect(after[`sessions/${SESSION_A}/threads/thread-1.json`]).toBe(
            before[`sessions/${SESSION_A}/threads/thread-1.json`]
        );
        expect(after[`sessions/${SESSION_A}/events.jsonl`]).toBe(before[`sessions/${SESSION_A}/events.jsonl`]);

        // The committed header lists ONLY the session this build accepted, while the refused
        // record is left in place: the index is authoritative, so the store starts normally over
        // the healthy row and the refused conversation stays on disk to recover instead of
        // vanishing behind the diagnostics.
        expect(readJson(indexFile(root)).sessions).toEqual([{ id: SESSION_B, ordinal: 1 }]);
        expect(new HarnessPersistence(root).load()?.sessions.map((session) => session.id)).toEqual([SESSION_B]);
        expect(stagingLeftovers(root)).toEqual([]);
    });

    it('reports a session the index still lists whose record is gone', () => {
        const root = tempRoot('missing-session');
        const persistence = new HarnessPersistence(root);

        persistence.save(fixtureOf());
        fs.rmSync(sessionFile(root, SESSION_A), { force: true });

        let failure: unknown;

        try {
            new HarnessPersistence(root).load();
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(HarnessPersistenceError);
        expect((failure as Error).message).toContain('record file is missing');
        expect((failure as Error).message).toContain(`session "${SESSION_A}"`);
        expect((failure as Error).message).toContain(sessionFile(root, SESSION_A));
    });

    it('refuses a session id that is not one safe path segment, naming index.json', () => {
        // THE DATA-LOSS PIN (the reason the session id gets the same grammar the thread id has).
        // `sessions/<id>` is a directory, and a dropped session's `threads/` tree is removed with
        // `fs.rmSync(..., { recursive: true })`. Before the grammar existed an `index.json` naming
        // `../../escape-sibling` made the NEXT commit delete
        // `<databaseRoot>/escape-sibling/threads/` — a tree OUTSIDE `<databaseRoot>/harness`,
        // i.e. bytes this package does not own. The refusal has to be as loud as a bad snapshot
        // (a quiet quarantine would adopt a session the operator can still see in the header).
        const root = tempRoot('session-traversal');
        const persistence = new HarnessPersistence(root);

        persistence.save(fixtureOf());

        // The decoy OUTSIDE the harness namespace, exactly where the traversal id resolves:
        // `<root>/harness/sessions/../../escape-sibling` == `<root>/escape-sibling`.
        const escapeDirectory = path.join(root, 'escape-sibling');
        const escapeThread = path.join(escapeDirectory, HARNESS_THREAD_DIRECTORY, 'thread-1.json');

        fs.mkdirSync(path.dirname(escapeThread), { recursive: true });
        fs.writeFileSync(path.join(escapeDirectory, HARNESS_SESSION_FILE), '{"id":"escape-sibling"}', 'utf8');
        fs.writeFileSync(escapeThread, JSON.stringify({ version: 2, sessionId: '../../escape-sibling', id: 'thread-1', messages: [] }), 'utf8');

        // The header now lists ONLY the traversal id, and its record exists at the traversed
        // path: with no grammar, `load()` would walk out of the tree and the next commit's erase
        // would delete it.
        const header = readJson(indexFile(root));

        header.sessions = [{ id: '../../escape-sibling', ordinal: 1 }];
        fs.writeFileSync(indexFile(root), JSON.stringify(header), 'utf8');

        const before = treeOf(root);
        let failure: unknown;
        // The SAME instance loads and then saves: the reader primes its footprint at the END of a
        // successful read, so before this grammar existed a header like this one primed
        // `../../escape-sibling` as a WRITTEN session and the very next `save()` — which no longer
        // named it — called `rmSync(<root>/escape-sibling/threads, { recursive: true })`.
        const escaped = new HarnessPersistence(root);

        try {
            escaped.load();
        } catch (error) {
            failure = error;
        }

        // Fatal, and naming the file the operator has to open — the same shape a corrupt header
        // or an unsupported version takes.
        expect(failure).toBeInstanceOf(HarnessPersistenceError);
        expect((failure as Error).message).toContain(HARNESS_INDEX_FILE);
        expect((failure as Error).message).toContain('is not one safe path segment');
        expect((failure as Error).message).toContain('"../../escape-sibling"');
        expect((failure as HarnessPersistenceError).file).toBe(indexFile(root));

        // Nothing was deleted, inside the tree or outside it: the refusal happens before the
        // reader opens a single shard, so the escaped paths were never even derived.
        expect(treeOf(root)).toEqual(before);
        expect(fs.existsSync(path.join(escapeDirectory, HARNESS_SESSION_FILE))).toBe(true);
        expect(fs.existsSync(escapeThread)).toBe(true);

        // And the writer that refused the header has NO primed footprint to erase from — the load
        // threw before the swap — so its next commit removes nothing outside the namespace either.
        escaped.save(fixtureOf([sessionOf(SESSION_A, [threadRow('thread-1', 1)])]));

        expect(fs.existsSync(escapeThread)).toBe(true);
        expect(fs.existsSync(path.join(escapeDirectory, HARNESS_SESSION_FILE))).toBe(true);
        expect(readJson(indexFile(root)).sessions).toEqual([{ id: SESSION_A, ordinal: 1 }]);
    });

    it('refuses to WRITE a session whose id is not one safe path segment, and writes nothing', () => {
        // The same rule on the write side, where the danger is the recursive erase rather than a
        // bad read. It must fail BEFORE the first `mkdir`: the commit's first unit already
        // derives `sessions/<id>/threads`, so an unsafe id cannot leave half a tree behind.
        const root = tempRoot('session-write-escape');
        const persistence = new HarnessPersistence(root);
        const escaped = { ...fixtureOf().sessions[0], id: '../../escape-sibling' };

        let failure: unknown;

        try {
            persistence.save(fixtureOf([escaped, sessionOf(SESSION_A, [threadRow('thread-1', 1)])]));
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(HarnessPersistenceError);
        expect((failure as Error).message).toContain('one safe path segment');
        expect((failure as Error).message).toContain('"../../escape-sibling"');
        // Nothing outside the namespace was created — no header, no session directory, and no
        // `<root>/escape-sibling`.
        expect(fs.existsSync(harnessDir(root))).toBe(false);
        expect(fs.existsSync(path.join(root, 'escape-sibling'))).toBe(false);
        expect(persistence.lastWriteError).toBeDefined();
    });

    it('ignores a transcript shard the index does not name', () => {
        const root = tempRoot('extra-shard');
        const persistence = new HarnessPersistence(root);

        persistence.save(fixtureOf());

        // A crash leftover, a hand copy, or a row the 256-record cap retired
        // (./sessions.ts `capThreadRecords`): the index is authoritative, so the extra file
        // is neither read nor deleted (no garbage collection in this layout).
        fs.writeFileSync(
            threadFile(root, SESSION_B, 'thread-99'),
            JSON.stringify({ version: 2, sessionId: SESSION_B, id: 'thread-99', messages: 'not an array' }),
            'utf8'
        );

        const loaded = new HarnessPersistence(root).load();

        expect((loaded!.sessions[0].core as unknown as { threads: Record<string, any>[] }).threads.map((row) => row.id)).toEqual(
            EXPECTED_ROWS
        );
        expect(fs.existsSync(threadFile(root, SESSION_B, 'thread-99'))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// R5 — the commit only touches what changed
// ---------------------------------------------------------------------------

describe('save() commits only the shards that changed (R5)', () => {
    it('rewrites only the shards of the session that changed', () => {
        const root = tempRoot('skip');
        const move = pinClock();
        const persistence = new HarnessPersistence(root);
        const database = fixtureOf();

        persistence.save(database);

        const before = inodesOf(root);
        const unchangedSession = `sessions/${SESSION_A}/session.json`;
        const unchangedTranscript = `sessions/${SESSION_A}/threads/thread-1.json`;
        const untouchedTranscript = `sessions/${SESSION_B}/threads/thread-11.json`;

        // One field of session B moves. Its record is the only document-level byte that
        // differs, so it is the only record rewritten; its transcripts did not change and
        // neither did ANY of session A's bytes.
        move(1_700_000_000_900);

        persistence.save(
            fixtureOf([
                { ...sessionOf(SESSION_B, EXPECTED_ROWS.map((id, index) => threadRow(id, index + 1))), updatedAt: 1_700_000_000_999 },
                sessionOf(SESSION_A, [threadRow('thread-1', 1)])
            ])
        );

        const after = inodesOf(root);

        expect(after[`sessions/${SESSION_B}/session.json`]).not.toBe(before[`sessions/${SESSION_B}/session.json`]);
        expect(after[unchangedSession]).toBe(before[unchangedSession]);
        expect(after[unchangedTranscript]).toBe(before[unchangedTranscript]);
        expect(after[untouchedTranscript]).toBe(before[untouchedTranscript]);

        // The content of the skipped files is still what it was, byte for byte.
        expect(readJson(sessionFile(root, SESSION_A)).updatedAt).toBe(1_700_000_000_001);
        expect(readJson(sessionFile(root, SESSION_B)).updatedAt).toBe(1_700_000_000_999);
        expect(stagingLeftovers(root)).toEqual([]);

        // And a transcript that DID change is the only thread shard rewritten in the next
        // commit: one appended message costs one file.
        const transcriptsBefore = inodesOf(root);

        move(1_700_000_000_950);

        const grown = EXPECTED_ROWS.map((id, index) => ({
            ...threadRow(id, index + 1),
            messages:
                id === 'thread-11'
                    ? [
                          { role: 'user', content: 'prompt of thread-11', messageId: 'm-thread-11' },
                          { role: 'assistant', content: 'answer', messageId: 'm-answer' }
                      ]
                    : threadRow(id, index + 1).messages
        }));

        persistence.save(
            fixtureOf([
                { ...sessionOf(SESSION_B, grown), updatedAt: 1_700_000_000_999 },
                sessionOf(SESSION_A, [threadRow('thread-1', 1)])
            ])
        );

        const afterTranscripts = inodesOf(root);

        expect(afterTranscripts[`sessions/${SESSION_B}/threads/thread-11.json`]).not.toBe(
            transcriptsBefore[`sessions/${SESSION_B}/threads/thread-11.json`]
        );
        expect(afterTranscripts[`sessions/${SESSION_B}/threads/thread-3.json`]).toBe(
            transcriptsBefore[`sessions/${SESSION_B}/threads/thread-3.json`]
        );
        expect(afterTranscripts[`sessions/${SESSION_B}/threads/thread-2.json`]).toBe(
            transcriptsBefore[`sessions/${SESSION_B}/threads/thread-2.json`]
        );
        expect(afterTranscripts[unchangedSession]).toBe(transcriptsBefore[unchangedSession]);
        expect(readJson(threadFile(root, SESSION_B, 'thread-11')).messages).toEqual([
            { role: 'user', content: 'prompt of thread-11', messageId: 'm-thread-11' },
            { role: 'assistant', content: 'answer', messageId: 'm-answer' }
        ]);
    });

    it('writes nothing at all when every shard is unchanged, the index included', () => {
        const root = tempRoot('noop');

        pinClock();
        const persistence = new HarnessPersistence(root);

        persistence.save(fixtureOf());

        const before = inodesOf(root);

        // The clock is FROZEN, so `savedAt` — the only non-content value in the layout — did
        // not move either, and the whole commit is a no-op. This is the shape a burst of
        // best-effort checkpoints of the same state takes.
        persistence.save(fixtureOf());

        expect(inodesOf(root)).toEqual(before);
        expect(stagingLeftovers(root)).toEqual([]);
    });

    it('reverts an out-of-band edit to a shard on the next save (v1 self-heal)', () => {
        // The hole the digest gate opened, and the reason the skip has a second condition. v1
        // rewrote the WHOLE document on every commit, so a byte someone changed behind the
        // store's back was gone by the next save. A payload digest cannot see such an edit — it
        // hashes the writer's own bytes, which did not change — so a digest-only gate keeps the
        // store's belief and the file's bytes apart for the rest of the process's life, and the
        // next restart adopts the outsider's bytes as if they were the truth.
        const root = tempRoot('self-heal');
        const move = pinClock();
        const persistence = new HarnessPersistence(root);
        const database = fixtureOf();

        persistence.save(database);

        const sessionKey = `sessions/${SESSION_A}/session.json`;
        const transcriptKey = `sessions/${SESSION_A}/threads/thread-1.json`;
        const untouchedKey = `sessions/${SESSION_B}/session.json`;
        const pristine = fs.readFileSync(sessionFile(root, SESSION_A), 'utf8');

        // A different BYTE LENGTH that still parses as the same record (`status` is one of the
        // three values the loader accepts), so the witness moves with the edit no matter what
        // granularity this filesystem reports for `mtimeMs`.
        fs.writeFileSync(sessionFile(root, SESSION_A), pristine.replace('"status":"idle"', '"status":"running"'), 'utf8');
        expect(fs.readFileSync(sessionFile(root, SESSION_A), 'utf8')).not.toBe(pristine);

        const before = inodesOf(root);

        // The document did NOT change, so every payload digest still matches what this writer
        // committed. That is precisely the case the witness decides.
        move(1_700_000_000_903);
        persistence.save(fixtureOf());

        // v1's outcome: the store's own bytes are back on the file.
        expect(fs.readFileSync(sessionFile(root, SESSION_A), 'utf8')).toBe(pristine);
        expect(inodesOf(root)[sessionKey]).not.toBe(before[sessionKey]);

        // And the saving the gate exists for is intact: every shard that was NOT edited is still
        // skipped, including the transcript of the session whose record was rewritten.
        expect(inodesOf(root)[transcriptKey]).toBe(before[transcriptKey]);
        expect(inodesOf(root)[untouchedKey]).toBe(before[untouchedKey]);
        expect(stagingLeftovers(root)).toEqual([]);

        // A reload sees the healed bytes, not the outsider's.
        expect(new HarnessPersistence(root).load()!.sessions.find((session) => session.id === SESSION_A)!.status).toBe('idle');
    });

    it('re-creates a shard that was deleted behind its own digest entry', () => {
        // The other half of the witness rule: a file that cannot be statted at all counts as
        // CHANGED. Skipping here would mean the store believes a shard exists that no reader can
        // open, and the thread would come back as an unreadable transcript instead of its own file.
        const root = tempRoot('heal-missing');
        const move = pinClock();
        const persistence = new HarnessPersistence(root);

        persistence.save(fixtureOf());

        const transcriptKey = `sessions/${SESSION_A}/threads/thread-1.json`;
        const untouchedKey = `sessions/${SESSION_B}/session.json`;
        const before = inodesOf(root);

        fs.rmSync(threadFile(root, SESSION_A, 'thread-1'));

        move(1_700_000_000_904);
        persistence.save(fixtureOf());

        // The file is back with its exact content — with a digest-only gate it would still be
        // missing, so that is the whole proof. Its inode is deliberately NOT pinned: this
        // filesystem hands a freshly created file the inode the unlinked one had just released,
        // so an inode change here would be luck rather than behaviour.
        expect(readJson(threadFile(root, SESSION_A, 'thread-1'))).toEqual({
            version: 2,
            sessionId: SESSION_A,
            id: 'thread-1',
            messages: [{ role: 'user', content: 'prompt of thread-1', messageId: 'm-thread-1' }]
        });
        // Only the missing file was rewritten — the stat check did not turn the whole commit back
        // into a full rewrite.
        expect(inodesOf(root)[untouchedKey]).toBe(before[untouchedKey]);

        // The stamp of the recreated file is in the map too, so the NEXT identical commit skips it
        // again instead of rewriting it every save.
        const afterHeal = inodesOf(root);

        move(1_700_000_000_905);
        persistence.save(fixtureOf());

        expect(inodesOf(root)[transcriptKey]).toBe(afterHeal[transcriptKey]);
        expect(stagingLeftovers(root)).toEqual([]);
    });

    it('erases a vanished session record and its shards, and keeps events.jsonl', () => {
        const root = tempRoot('vanished');
        const move = pinClock();
        const persistence = new HarnessPersistence(root);

        persistence.save(fixtureOf());

        // The journal is the session's own (./journal.ts) and the store — not the
        // persistence layer — owns its lifetime. Dropping a session from the DOCUMENT must
        // therefore leave it exactly where it is, which is v1's "row erased, journal kept".
        const journal = journalFile(root, SESSION_B);

        fs.writeFileSync(journal, '{"type":"header","v":1,"sessionId":"ses-b","createdAt":1}\n', 'utf8');

        const journalBytes = fs.readFileSync(journal, 'utf8');
        const keptTranscript = threadFile(root, SESSION_A, 'thread-1');
        const keptBefore = inodesOf(root)[`sessions/${SESSION_A}/threads/thread-1.json`];

        move(1_700_000_000_901);
        persistence.save(fixtureOf([sessionOf(SESSION_A, [threadRow('thread-1', 1)])]));

        expect(fs.existsSync(sessionFile(root, SESSION_B))).toBe(false);
        expect(fs.existsSync(path.join(harnessDir(root), 'sessions', SESSION_B, HARNESS_THREAD_DIRECTORY))).toBe(false);
        expect(fs.existsSync(threadFile(root, SESSION_B, 'thread-3'))).toBe(false);
        expect(fs.readFileSync(journal, 'utf8')).toBe(journalBytes);
        expect(fs.readdirSync(path.join(harnessDir(root), 'sessions', SESSION_B))).toEqual(['events.jsonl']);
        expect(readJson(indexFile(root)).sessions).toEqual([{ id: SESSION_A, ordinal: 1 }]);

        // The surviving session is untouched by the erase, and a reload sees exactly the one
        // session the header lists.
        expect(inodesOf(root)[`sessions/${SESSION_A}/threads/thread-1.json`]).toBe(keptBefore);
        expect(fs.existsSync(keptTranscript)).toBe(true);
        expect(new HarnessPersistence(root).load()!.sessions.map((session) => session.id)).toEqual([SESSION_A]);
    });

    it('retires a capped-out thread row and loses its shard in the same commit', () => {
        const root = tempRoot('cap');
        const move = pinClock();
        const persistence = new HarnessPersistence(root);
        const rows = EXPECTED_ROWS.map((id, index) => threadRow(id, index + 1));

        persistence.save(fixtureOf([sessionOf(SESSION_B, rows), sessionOf(SESSION_A, [threadRow('thread-1', 1)])]));

        expect(fs.readdirSync(path.join(harnessDir(root), 'sessions', SESSION_B, HARNESS_THREAD_DIRECTORY)).sort()).toEqual([
            'thread-11.json',
            'thread-2.json',
            'thread-3.json'
        ]);

        // The 256-record cap (./sessions.ts `capThreadRecords`) retires the OLDEST inactive
        // row before the document is built, so the persistence layer's job is one thing only:
        // a row that is gone from the record loses its shard, and the record that indexes it
        // is durable first. A stale transcript file must not outlive the row that named it.
        move(1_700_000_000_902);
        persistence.save(
            fixtureOf([sessionOf(SESSION_B, rows.slice(1)), sessionOf(SESSION_A, [threadRow('thread-1', 1)])])
        );

        expect(fs.existsSync(threadFile(root, SESSION_B, 'thread-3'))).toBe(false);
        expect(fs.readdirSync(path.join(harnessDir(root), 'sessions', SESSION_B, HARNESS_THREAD_DIRECTORY)).sort()).toEqual([
            'thread-11.json',
            'thread-2.json'
        ]);
        expect(readJson(sessionFile(root, SESSION_B)).core.threads.map((row: Record<string, unknown>) => row.id)).toEqual([
            'thread-11',
            'thread-2'
        ]);

        const loaded = new HarnessPersistence(root).load();

        expect((loaded!.sessions[0].core as unknown as { threads: Record<string, any>[] }).threads.map((row) => row.id)).toEqual([
            'thread-11',
            'thread-2'
        ]);
        expect(stagingLeftovers(root)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// R4 — the v1 store, and the store that has no root at all
// ---------------------------------------------------------------------------

describe('v1 and in-memory stores (R4)', () => {
    const LEGACY = JSON.stringify({
        version: 1,
        savedAt: 1_600_000_000_000,
        registry: [PRESET],
        sessions: [{ id: 'ses-old', turns: [{ id: 't1' }] }]
    });

    it('reports a v1 state.json once, starts empty, and never touches the file', () => {
        const root = tempRoot('legacy-v1');
        const legacy = path.join(harnessDir(root), HARNESS_DATABASE_FILE);

        fs.mkdirSync(harnessDir(root), { recursive: true });
        fs.writeFileSync(legacy, LEGACY, 'utf8');

        const errors: string[] = [];

        vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
            errors.push(args.map(String).join(' '));
        });

        const persistence = new HarnessPersistence(root);

        // The load is a first run for THIS build: `undefined`, i.e. an empty database — not a
        // migration guess and not a crash.
        expect(persistence.load()).toBeUndefined();

        // ...reported through the restore-diagnostic channel (the store's reporter-or-stderr
        // convention, ./sessions.ts:4452-4467), naming the file an operator's sessions are
        // still in.
        expect(persistence.restoreDiagnostics).toHaveLength(1);
        expect(persistence.restoreDiagnostics[0]).toContain(legacy);
        expect(persistence.restoreDiagnostics[0]).toContain('single-file v1 store');
        expect(persistence.restoreDiagnostics[0]).toContain('not read, rewritten, renamed or deleted');
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('[harness] skipped the v1 harness database:');

        // ONCE: a second load (a second runtime over the same root) does not repeat itself.
        persistence.load();

        expect(persistence.restoreDiagnostics).toHaveLength(1);
        expect(errors).toHaveLength(1);

        // Nothing was read from it, and nothing was written to it — not by the load, and not
        // by the v2 commit that lands beside it.
        const before = fs.statSync(legacy);
        const persistence2 = new HarnessPersistence(root);

        pinClock();
        persistence2.save(fixtureOf());

        expect(fs.readFileSync(legacy, 'utf8')).toBe(LEGACY);
        const after = fs.statSync(legacy);

        expect(after.size).toBe(before.size);
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect(fs.readdirSync(harnessDir(root)).sort()).toEqual([
            HARNESS_INDEX_FILE,
            'sessions',
            HARNESS_DATABASE_FILE
        ]);
    });

    it('reports a v1 store on its own channel when the host injects one', () => {
        const root = tempRoot('legacy-reporter');
        const legacy = path.join(harnessDir(root), HARNESS_DATABASE_FILE);

        fs.mkdirSync(harnessDir(root), { recursive: true });
        fs.writeFileSync(legacy, LEGACY, 'utf8');

        const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const notes: string[] = [];
        const persistence = new HarnessPersistence(root);

        persistence.onRestoreNote = (error: Error) => notes.push(error.message);

        expect(persistence.load()).toBeUndefined();
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain('single-file v1 store');
        // The stderr fallback is replaced, not doubled, when a host owns the channel.
        expect(stderr.mock.calls).toHaveLength(0);
    });

    it('reads nothing at all for an in-memory store: no header, no session directory', async () => {
        const root = tempRoot('in-memory');
        const runtime = runtimeOf(undefined, [scriptedPreset()]);

        expect(runtime.root).toBeUndefined();
        expect(runtime.persistence).toBeUndefined();

        const created = await runtime.store.create('one');
        const running = await runtime.store.enqueue(created.id, 'nothing durable');

        await running.settled;
        await runtime.store.waitForIdle(created.id);
        await runtime.store.persistRegistry();
        runtime.store.dispose();

        // The no-root guards in ./sessions.ts (`persistOrThrow` / `persistBestEffort`) are the
        // reason this is empty rather than merely unwritten: the writer is never reached.
        expect(fs.existsSync(harnessDir(root))).toBe(false);
        expect(fs.readdirSync(root)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// The store-level half: real transcripts, a real journal, and the existing tolerance
// ---------------------------------------------------------------------------

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'server-secret-key',
    model: 'scripted/test'
};

const DEFAULTS = { baseURL: SETTINGS.baseURL, model: SETTINGS.model, hasApiKey: true };

// The unconfigured search entry, so the catalogue never depends on the runner's .env.
const CATALOGUE = createToolCatalogue({
    websearch: createWebSearchCatalogueEntry({ configuration: { env: {} } })
});

const answerStream = (text: string): HarnessStream =>
    async function* (): AsyncGenerator<HarnessStreamEvent> {
        yield { type: 'text', delta: text };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };

// A one-agent scripted harness wired to the state-change observer exactly like a production
// preset, so the store's own persistence path runs.
const scriptedPreset = (name = 'one', text = 'an answer'): HarnessPreset => ({
    name,
    title: name,
    description: `${name} scripted preset`,
    requiresEndpoint: false,
    entry: name,
    ranks: { [name]: 'A' } as Record<string, 'A'>,
    agents: [name],
    tools: [],
    builtin: true,
    editable: true,
    create: (settings, progress, report) =>
        harness({
            agents: {
                [name]: agent({
                    model: settings.model,
                    instruction: `You are the ${name} scripted agent.`,
                    stream: answerStream(text)
                })
            },
            entry: name,
            presets: false,
            report: {
                progress,
                ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
            }
        })
});

const runtimeOf = (root: string | undefined, presets: HarnessPreset[]): HarnessRuntime =>
    createHarnessRuntime({
        ...(root === undefined ? {} : { root }),
        settings: SETTINGS,
        defaults: DEFAULTS,
        registry: createHarnessRegistry(presets),
        catalogue: CATALOGUE,
        loadEnvironment: false
    });

// Two plain submits = two host conversations (`thread-1`, `thread-2`), each with its own
// transcript, then an explicit durable commit (`persistRegistry`) so the assertions below do
// not race the deferred checkpoint window.
const persistTwoConversations = async (root: string): Promise<{ runtime: HarnessRuntime; sessionId: string }> => {
    const runtime = runtimeOf(root, [scriptedPreset()]);
    const created = await runtime.store.create('one');
    const first = await runtime.store.enqueue(created.id, 'first prompt');

    await first.settled;

    const second = await runtime.store.enqueue(created.id, 'second prompt');

    await second.settled;
    await runtime.store.waitForIdle(created.id);
    await runtime.store.persistRegistry();

    return { runtime, sessionId: created.id };
};

describe('a real store over the v2 layout', () => {
    it('persists each conversation as its own shard, beside events.jsonl, and restores the same graph', async () => {
        const root = tempRoot('store-round-trip');
        const { runtime, sessionId } = await persistTwoConversations(root);
        const persistence = runtime.persistence!;
        const before = persistence.load();

        expect(before).toBeDefined();

        // One session directory, and it holds all three files side by side: the journal is
        // unchanged and `threads/` simply coexists with it.
        expect(fs.readdirSync(path.join(harnessDir(root), 'sessions', sessionId)).sort()).toEqual([
            'events.jsonl',
            HARNESS_SESSION_FILE,
            HARNESS_THREAD_DIRECTORY
        ]);
        expect(fs.readdirSync(path.join(harnessDir(root), 'sessions', sessionId, HARNESS_THREAD_DIRECTORY)).sort()).toEqual([
            'thread-1.json',
            'thread-2.json'
        ]);

        // The record holds the roster and every bookkeeping field; only the transcripts moved.
        const stored = readJson(sessionFile(root, sessionId));

        expect(stored.core.threads.map((row: Record<string, unknown>) => row.id)).toEqual(['thread-1', 'thread-2']);
        expect(stored.core.threads.every((row: Record<string, unknown>) => !('messages' in row))).toBe(true);
        expect(stored.turns.map((turn: { prompt: string }) => turn.prompt)).toEqual(['first prompt', 'second prompt']);

        // A shard carries the transcript of ONE conversation, exactly as the row used to.
        const transcript = readJson(threadFile(root, sessionId, 'thread-2'));

        expect(transcript.version).toBe(HARNESS_DATABASE_VERSION);
        expect(transcript.sessionId).toBe(sessionId);
        expect(transcript.id).toBe('thread-2');
        expect(transcript.messages.filter((message: { role: string }) => message.role === 'user').map((message: { content: string }) => message.content)).toEqual([
            'second prompt'
        ]);

        // `savedAt` is the ONE wall-clock field of the layout and it lives in `index.json`
        // alone (./persistence.ts `harnessIndexDocumentOf`). `load()` READS it from that header
        // instead of inventing a stamp, which is what the two comparisons here pin — one on each
        // side of the restart, each against the header's own bytes at the same instant.
        const headerBefore = readJson(indexFile(root));

        expect(before!.savedAt).toBe(headerBefore.savedAt);

        runtime.store.dispose();

        // A second process over the same root: the reassembled graph is textually identical to
        // the one the first process read, and the store rebuilds the conversations from it. The
        // two loads differ in exactly one field, `savedAt`: `dispose()` writes a final
        // checkpoint, and a checkpoint re-stamps the header. Everything that MOVED between files
        // — the record fields, the thread rows in order, each transcript back on its row — is
        // therefore compared whole, without that stamp.
        const restarted = runtimeOf(root, [scriptedPreset()]);
        const after = restarted.persistence!.load();
        const { savedAt: writtenAt, ...writtenGraph } = before!;
        const { savedAt: reloadedAt, ...reloadedGraph } = after!;

        expect(JSON.stringify(reloadedGraph)).toBe(JSON.stringify(writtenGraph));
        expect(reloadedAt).toBe(readJson(indexFile(root)).savedAt);

        const restored = restarted.store.get(sessionId);

        expect(restored.turns.map((turn) => turn.prompt)).toEqual(['first prompt', 'second prompt']);
        expect((restored.threads ?? []).map((row) => row.id)).toEqual(['thread-1', 'thread-2']);
        expect(restarted.persistence!.restoreDiagnostics).toEqual([]);

        restarted.store.dispose();
    });

    it('routes a deleted thread shard through the existing invalidThreads tolerance', async () => {
        const root = tempRoot('store-torn');
        const { runtime, sessionId } = await persistTwoConversations(root);

        runtime.store.dispose();

        // Tear the set: one transcript file gone, the row that names it still in
        // `session.json`, and the index still listing the session.
        fs.rmSync(threadFile(root, sessionId, 'thread-2'), { force: true });

        // Persistence level: the row comes back WITH a marker transcript, and the session is not
        // dropped — no new error class, nothing thrown. The marker is a string on purpose:
        // ./sessions.ts repairs tool calls (a `for...of` over `messages`) BEFORE it tolerates
        // transcripts, so a string is the only non-array value that reaches the tolerance, and an
        // empty array would have been silent data loss (see ./persistence.ts
        // `HARNESS_MISSING_THREAD_TRANSCRIPT`).
        const reader = new HarnessPersistence(root);
        const loaded = reader.load();
        const rows = (loaded!.sessions[0].core as unknown as { threads: Record<string, any>[] }).threads;

        expect(rows.map((row) => [row.id, row.messages])).toEqual([
            ['thread-1', expect.any(Array)],
            ['thread-2', HARNESS_MISSING_THREAD_TRANSCRIPT]
        ]);

        // The missing file is said out loud, with its path — the tolerance downstream can only
        // ever report "messages must be an array", which is true but not actionable. The same
        // owner reporting the same sentence once is the point of ./persistence.ts `noteRestore`,
        // so a second read must not repeat it.
        const missingNote =
            `Session "${sessionId}" conversation "thread-2" names the transcript file ` +
            `${threadFile(root, sessionId, 'thread-2')}, which is missing; the conversation is kept with a ` +
            `placeholder transcript and reported as unreadable.`;

        expect(reader.restoreDiagnostics).toEqual([missingNote]);

        reader.load();

        expect(reader.restoreDiagnostics).toEqual([missingNote]);

        // The identity fields the tolerance copies are the ROW's, read off `session.json` —
        // the same bytes ./sessions.ts:3836-3851 reads — so the expectation below cannot
        // drift from the layout it is pinning.
        const storedRow = readJson(sessionFile(root, sessionId)).core.threads.find(
            (row: Record<string, unknown>) => row.id === 'thread-2'
        ) as Record<string, unknown>;

        // Store level: ./sessions.ts `tolerateThreadTranscripts` is what handles the shape,
        // so the session restores and reports the conversation through `invalidThreads`.
        const restarted = runtimeOf(root, [scriptedPreset()]);
        const restored = restarted.store.get(sessionId);

        // `store.get()` answers with the session VIEW, so this is the array form built by
        // `invalidThreadViews` (./sessions.ts:4734) — the Map ledger
        // (`Session.invalidThreads`, ./sessions.ts:687) is the internal one.
        expect(restored.invalidThreads).toEqual([
            {
                id: 'thread-2',
                // The refusal text of the shared transcript validator — the message the
                // transcript editor shows, unchanged from the inline-corruption case.
                error: 'thread "thread-2" messages must be an array.',
                // A missing shard has no raw bytes to retain, so the raw value the editor shows
                // is the marker; an unparseable shard would carry its bytes verbatim.
                messages: HARNESS_MISSING_THREAD_TRANSCRIPT,
                ...(typeof storedRow.label === 'string' ? { label: storedRow.label } : {}),
                ...(typeof storedRow.agent === 'string' ? { agent: storedRow.agent } : {})
            }
        ]);

        // The surviving conversation is intact, and the broken one keeps its identity: the
        // roster still addresses it, which is the point of the placeholder.
        expect(restored.turns.map((turn) => turn.prompt)).toEqual(['first prompt', 'second prompt']);
        expect((restored.threads ?? []).map((row) => row.id)).toEqual(['thread-1', 'thread-2']);
        // The only read-side note this root produces is the missing file, and it is reported
        // ONCE even though `load()` ran twice above (the dedupe in ./persistence.ts
        // `noteRestore`).
        expect(restarted.persistence!.restoreDiagnostics).toEqual([missingNote]);

        restarted.store.dispose();
    });
});

// The IO worker's operation table, driven in-process against the real filesystem.
//
// `executeIoCommand` is the whole worker body minus the message port, so these tests
// exercise THE SAME dispatch ./io-client.test.ts runs on a real worker thread - one
// operation in, one receipt out, real files on disk under the repo-root Temp/.
//
// What they pin (R5):
//   - byte-identity with the inline writer PER SHARD (the two write modes must not produce
//     two different databases), for all three unit kinds,
//   - failure-text parity, so a 500 or a journal report reads the same in both modes,
//   - the exact durability answer for every operation ('durable' vs 'written'),
//   - the ordered shard commit (threads -> session.json -> index.json) is loadable by the
//     store's own loader - the restart path is the real acceptance test,
//   - and the refusals that must be loud: an unknown frame, an oversized SHARD (named by
//     path, measured, sibling units untouched), and a target that disagrees with the unit.
//
// Note on state: the worker caches one `HarnessJournal` per (root, sessionId) in a
// module map, so each test uses its own session id, and the `shutdown` test runs last
// (vitest executes declarations in order) because draining affects every cached handle.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HarnessJournal, journalLine, HARNESS_JOURNAL_VERSION } from '../journal';
import {
    HARNESS_DATABASE_VERSION,
    HARNESS_INDEX_FILE,
    HARNESS_SESSION_FILE,
    HarnessPersistence,
    harnessIndexDocumentOf,
    harnessSessionDirectoryOf,
    harnessSessionFileOf,
    harnessShardFileOf,
    harnessThreadDirectoryOf,
    harnessThreadFileOf,
    serializeHarnessShard,
    splitHarnessSessionRecord,
    writeHarnessShardFile,
    createHarnessStagingSequence
} from '../persistence';
// `HarnessShardUnit` is the UNION; the three precise members are imported because `unitsOf`
// below declares the exact unit kind it builds for each slot. Spreading a union-typed value
// produces a union of spreads, and a fresh literal spread is excess-property-checked against
// EVERY member of the target union, so `{ ...units.thread, id, messages }` at
// ./io-worker.test.ts:638 was refused with "'id' does not exist in type 'HarnessIndexShardUnit'"
// even though the value IS a thread unit. Naming the members keeps the helper's contract honest.
import type { HarnessDatabase, HarnessIndexShardUnit, HarnessSessionShardUnit, HarnessShardUnit, HarnessThreadShardUnit } from '../persistence';
// The snapshot version a session's `core` must carry, asserted by the loader these worker
// commits are read back through (../persistence.ts `requireCoreSnapshotVersion` ->
// ../../core/snapshot.ts `HARNESS_SNAPSHOT_VERSION`). This suite writes shards with the worker
// loop and then reads them with a plain `HarnessPersistence.load()`, so its hand-built core
// used to carry an arbitrary `version: 1`; the number is part of the read contract now, and
// pinning the constant keeps the fixture honest the day the kernel bumps the snapshot.
import { HARNESS_SNAPSHOT_VERSION } from '../../engine/core/snapshot';
import {
    configureIoWorker,
    executeIoCommand,
    ioWorkerLimits,
    ioWorkerOpenJournals,
    runIoWorker
} from './io-worker-loop';
import { IO_PROTOCOL_VERSION, ioJournalKey } from './io-protocol';
import type { IoJournalTarget, IoReply, IoResult, IoShardTarget } from './io-protocol';

// This file is one directory deeper than ../journal.test.ts (src/server/workers), so
// the package root is three levels up. Scratch still belongs in the REPO-root Temp/.
const PACKAGE_ROOT = path.resolve(__dirname, '../../..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const roots: string[] = [];

const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-io-worker-${label}-`));

    roots.push(root);

    return root;
};

afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// The database root's `harness` directory - spelled the way `HarnessPersistence` spells
// it, so a mismatch between the two spellings would fail these tests instead of quietly
// writing somewhere else.
const harnessDirectory = (root: string): string => path.join(root, 'harness');

// A shard frame target derived from the unit with A1's OWN primitive
// (`harnessShardFileOf`) - including the thread shard's id-derived file name, which a
// hand-built target would get wrong. If the client and the worker ever disagree about
// where a shard goes, that is caught by the drift test below; these frames deliberately
// agree by construction.
const targetOfUnit = (unit: HarnessShardUnit): IoShardTarget => ({
    kind: unit.kind,
    directory: unit.directory,
    file: harnessShardFileOf(unit)
});

const journalTarget = (root: string, sessionId: string): IoJournalTarget => ({
    root: harnessDirectory(root),
    sessionId
});

// A record the store's own reader accepts: `definition` and `preset` carry every field
// `readDescriptor`/`readPresetRecord` require, and `usage.total` is mandatory, so a
// worker-written shard survives `load()` for the same reasons a real one does.
const PRESET = {
    name: 'live',
    title: 'Live',
    description: 'd',
    requiresEndpoint: false,
    // The stored shape of the rank model: `entry` + `ranks`, required by the readers, with the
    // retired `primary`/`subagents` keys REFUSED (../persistence.ts `requireNoLegacyRosterKeys`) —
    // see the matching fixture in ./io-client.test.ts.
    entry: 'a',
    // `as const` keeps the rank letter a LITERAL. PRESET is declared on its own and only ever
    // SPREAD into the session row below (`preset: { ...PRESET }`), so `ranks` gets no contextual
    // type from `HarnessPresetRecord` and a bare 'A' would widen to `string`, which
    // `Record<string, AgentRank>` refuses (../types/index.ts:1469 `AgentRank` is the A–Z letter
    // union; ../persistence.ts:294 is the field). Same reason `template` below carries `as const`,
    // and the spelling the sibling suites already use (../background.test.ts:181,
    // ../../harness.thread-epoch.test.ts:132).
    ranks: { a: 'A' as const },
    agents: ['a'],
    tools: [],
    builtin: true,
    editable: true,
    template: 'scripted' as const
};

const DEFINITION = {
    name: 'live',
    title: 'Live',
    description: 'd',
    requiresEndpoint: false,
    entry: 'a',
    // `as const` for the same reason as PRESET above: DEFINITION is spread into the row's
    // `definition` field, so `ranks` must keep the literal type to satisfy
    // `HarnessDescriptor.ranks: Record<string, AgentRank>` (../persistence.ts `readDescriptor`).
    ranks: { a: 'A' as const },
    agents: ['a'],
    tools: [],
    builtin: true,
    editable: true
};

// R5: the conversation content lives in `core.threads[]` - the rows the splitter moves
// into `threads/<id>.json`. The id matches `HARNESS_THREAD_ID_PATTERN`, so the transcript
// DOES split (a foreign id would stay inline, and the test would silently stop covering
// the thread shard).
const TRANSCRIPT = [{ role: 'user', text: 'the message' }];

const document = (marker: string): HarnessDatabase => ({
    version: HARNESS_DATABASE_VERSION,
    savedAt: 1,
    registry: [],
    sessions: [
        {
            id: 'session-1',
            harness: 'live',
            preset: { ...PRESET },
            definition: { ...DEFINITION },
            settings: { baseURL: 'http://scripted.invalid/v1', model: 'scripted/test' },
            status: 'idle',
            createdAt: 1_000,
            updatedAt: 2_000,
            turns: [
                {
                    index: 0,
                    id: `turn-${marker}`,
                    prompt: marker,
                    status: 'done',
                    startedAt: 1,
                    updatedAt: 2,
                    usage: { input: 1, output: 1, total: 2 },
                    events: []
                }
            ],
            queue: [],
            core: {
                // NOT a free number any more: the loader asserts the snapshot version (see the
                // import of `HARNESS_SNAPSHOT_VERSION` above).
                version: HARNESS_SNAPSHOT_VERSION,
                agents: {},
                memory: {},
                threads: [{ id: 'thread-1', title: 't', messages: TRANSCRIPT }]
            } as unknown as HarnessDatabase['sessions'][number]['core']
        }
    ]
});

const emptyDocument = (): HarnessDatabase => ({ version: HARNESS_DATABASE_VERSION, savedAt: 1, registry: [], sessions: [] });

// The three units of one document, built through A1's own primitives - the same call the
// client's split makes (./io-client.ts `harnessShardUnitsOf`).
// Each slot is annotated with the EXACT `HarnessShardUnit` member it constructs (the `kind`
// discriminant is a literal in the body), not the wide union: a caller that spreads one of
// these units then gets a single object type instead of a union of three, which is what makes
// the `{ ...units.thread, id: 'thread-2', ... }` thread unit in the record-cap test type-check
// against `HarnessShardUnit` (./io-worker.test.ts `removes only the transcript...`).
const unitsOf = (
    root: string,
    doc: HarnessDatabase,
    savedAt: number
): { thread: HarnessThreadShardUnit; session: HarnessSessionShardUnit; index: HarnessIndexShardUnit } => {
    const record = doc.sessions[0];
    const { record: stored } = splitHarnessSessionRecord(record);

    return {
        thread: { kind: 'thread', directory: harnessThreadDirectoryOf(harnessDirectory(root), record.id), sessionId: record.id, id: 'thread-1', messages: TRANSCRIPT },
        session: { kind: 'session', directory: harnessSessionDirectoryOf(harnessDirectory(root), record.id), sessionId: record.id, record: stored },
        index: { kind: 'index', directory: harnessDirectory(root), document: harnessIndexDocumentOf(doc, savedAt) }
    };
};

// A frame in, the worker's reply out. Typed loosely on purpose: part of what these
// tests pin is that a MALFORMED frame is refused, so the helper cannot demand a shape.
const call = (frame: unknown): IoReply => executeIoCommand(frame);

const unwrap = (reply: IoReply): IoResult => {
    expect(reply.kind).toBe('result');

    return reply as IoResult;
};

const shardCall = (callId: number, unit: HarnessShardUnit, savedAt: number): IoReply =>
    call({ kind: 'shard.save', callId, target: targetOfUnit(unit), unit, savedAt });

describe('handshake and shutdown', () => {
    it('answers hello with the protocol version this build speaks', () => {
        expect(call({ kind: 'hello', callId: 0 })).toEqual({ kind: 'hello', callId: 0, version: IO_PROTOCOL_VERSION, ok: true });
    });

    it('refuses a frame it cannot parse, naming the offender', () => {
        // A silently dropped frame shows up later as a request that never returned, so
        // the answer must say which frame and why. R5: a v1 `checkpoint.save` frame from a
        // mismatched bundle is exactly such a frame - the version handshake normally
        // refuses the bundle first, but the loop still answers rather than hanging.
        expect(call({ kind: 'checkpoint.save', callId: 0 })).toEqual({ kind: 'fault', message: 'Unrecognized IO frame: kind="checkpoint.save" callId=0.' });
        expect(call(null)).toEqual({ kind: 'fault', message: 'Unrecognized IO frame: object.' });
        expect(call({ kind: 'journal.append', callId: 3, target: { root: '/r', sessionId: 's' }, record: { turnId: 't', index: -1, at: 1, event: {} } })).toEqual({
            kind: 'fault',
            // A rejected frame still names its operation, so the caller waiting on that
            // callId is told instead of left hanging.
            callId: 3,
            message: 'Unrecognized IO frame: kind="journal.append" callId=3.'
        });
    });
});

describe('shard.save', () => {
    it('commits one thread shard durably and reports the exact bytes it wrote', () => {
        const root = tempRoot('save-thread');
        const savedAt = 1_700_000_000_000;
        const units = unitsOf(root, document('one'), savedAt);

        const reply = unwrap(shardCall(1, units.thread, savedAt));

        expect(reply.outcome).toBe('durable');
        expect(reply.bytes).toBe(serializeHarnessShard(units.thread).length);
        expect(reply.durationMs).toBeTypeOf('number');

        const threadFile = harnessShardFileOf(units.thread);

        // The thread shard carries its own identity: a recovery tool picking up ONE file
        // can still tell which session and which thread it is (../persistence.ts
        // `serializeHarnessShard`).
        expect(JSON.parse(fs.readFileSync(threadFile, 'utf8'))).toEqual({
            version: HARNESS_DATABASE_VERSION,
            sessionId: 'session-1',
            id: 'thread-1',
            messages: TRANSCRIPT
        });

        // No staging file survives a successful commit.
        expect(fs.readdirSync(units.thread.directory)).toEqual(['thread-1.json']);
    });

    it('writes byte-identical bytes to the synchronous inline writer, for every unit kind', () => {
        // The one property that makes two write modes safe: the same UNIT through either
        // path is the same file, so a database written in worker mode restores in inline
        // mode and back. R5 asserts it per kind - index, session and thread each have
        // their own serializer branch, and each must match.
        const workerRoot = tempRoot('identity-worker');
        const inlineRoot = tempRoot('identity-inline');
        const savedAt = 1_700_000_000_001;
        const doc = document('same');

        for (const unit of Object.values(unitsOf(workerRoot, doc, savedAt))) {
            const kind = unit.kind;

            // The unit for the INLINE writer must point at the inline root, not the
            // worker's - same content, different directory.
            const inlineUnit: HarnessShardUnit =
                kind === 'index'
                    ? { ...unit, directory: harnessDirectory(inlineRoot) }
                    : kind === 'session'
                      ? { ...unit, directory: harnessSessionDirectoryOf(harnessDirectory(inlineRoot), unit.sessionId) }
                      : { ...unit, directory: harnessThreadDirectoryOf(harnessDirectory(inlineRoot), unit.sessionId) };

            // The worker writes the worker root; the synchronous writer writes the inline
            // root; the two files must then be byte-for-byte equal.
            unwrap(shardCall(2, unit, savedAt));
            writeHarnessShardFile(inlineUnit, { sequence: createHarnessStagingSequence() });

            expect(fs.readFileSync(harnessShardFileOf(unit), 'utf8')).toBe(fs.readFileSync(harnessShardFileOf(inlineUnit), 'utf8'));
            expect(fs.readFileSync(harnessShardFileOf(unit), 'utf8')).toBe(serializeHarnessShard(unit));
        }

        // The index shard is the header: one file, the v2 name, and the only file that
        // carries the commit's timestamp.
        expect(fs.readdirSync(harnessDirectory(workerRoot))).toContain(HARNESS_INDEX_FILE);
        expect((JSON.parse(fs.readFileSync(harnessShardFileOf(unitsOf(workerRoot, doc, savedAt).index), 'utf8')) as { savedAt: number }).savedAt).toBe(savedAt);
    });

    it('commits the ordered shard set a strict save posts, and the store loader reads it back', () => {
        // The restart path is the real test of the ORDERING contract: the client posts
        // threads, then each session.json, then index.json (./io-protocol.ts
        // `IO_SHARD_ORDER`), and this FIFO loop applies them in that order. `load()` then
        // starts at `index.json`, follows the session, and re-attaches the transcript from
        // the thread shard - every referenced file was on disk before the file that
        // references it, or this load would fail.
        const root = tempRoot('ordered-commit');
        const savedAt = 1_700_000_000_002;
        const doc = document('ordered');
        const units = unitsOf(root, doc, savedAt);

        unwrap(shardCall(3, units.thread, savedAt));
        unwrap(shardCall(4, units.session, savedAt));
        const committed = unwrap(shardCall(5, units.index, savedAt));

        expect(committed.outcome).toBe('durable');

        const loaded = new HarnessPersistence(root).load();

        expect(loaded?.savedAt).toBe(savedAt);
        expect(loaded?.sessions[0]?.turns[0]?.id).toBe('turn-ordered');
        // The transcript came back from ITS OWN file, re-attached in `core.threads` order.
        expect((loaded?.sessions[0]?.core as unknown as { threads: { id: string; messages: unknown }[] }).threads[0]).toEqual({
            id: 'thread-1',
            title: 't',
            messages: TRANSCRIPT
        });
    });

    it('refuses to commit a shard above the configured frame bound, naming the shard, and leaves its siblings committed', () => {
        // R5's per-unit promise in one test: the size guard measures ONE file, refuses
        // ONE file, and the other shards of the same commit are unaffected. Under v1 the
        // same event was "the whole database is uncommittable"; under R5 it is one
        // oversized conversation, and the operator is told WHICH file.
        const root = tempRoot('oversize');
        const savedAt = 1_700_000_000_003;
        const doc = document('wide');
        const units = unitsOf(root, doc, savedAt);

        unwrap(shardCall(6, units.session, savedAt));
        unwrap(shardCall(7, units.index, savedAt));

        const previous = ioWorkerLimits();

        configureIoWorker({ maxFrameBytes: 64 });

        const reply = call({ kind: 'shard.save', callId: 8, target: targetOfUnit(units.thread), unit: units.thread, savedAt });

        configureIoWorker(previous);

        const threadBytes = serializeHarnessShard(units.thread).length;

        expect(reply).toEqual({
            kind: 'failure',
            callId: 8,
            ok: false,
            durationMs: expect.any(Number),
            // The refusal still reports the measured size: that is how the coordinator
            // learns to stop cloning a shard it cannot commit, PER PATH (./io-client.ts).
            bytes: threadBytes,
            error: {
                code: 'frame-too-large',
                message: `The thread shard ${harnessShardFileOf(units.thread)} is ${threadBytes} bytes, above the 64 byte IO frame limit.`,
                path: harnessShardFileOf(units.thread)
            }
        });

        // Refused means NOT written - but ONLY for that shard: the session and the index
        // are exactly as the two earlier frames left them, and the loader reads the
        // session with its transcript row tolerated as missing (the torn-set rule).
        expect(fs.existsSync(harnessShardFileOf(units.thread))).toBe(false);
        expect(fs.existsSync(harnessShardFileOf(units.session))).toBe(true);
        expect(fs.existsSync(harnessShardFileOf(units.index))).toBe(true);
        expect(new HarnessPersistence(root).load()?.sessions[0]?.turns[0]?.id).toBe('turn-wide');
        expect(ioWorkerLimits()).toEqual(previous);
    });

    it('refuses a frame whose target disagrees with the unit, and writes nothing', () => {
        // The layout-drift guard: the coordinator spelled the destination with A1's own
        // primitives, so a mismatch means client and worker were loaded from different
        // layouts. Writing anyway would put bytes somewhere the reader never looks.
        const root = tempRoot('drift');
        const unit: HarnessShardUnit = { kind: 'index', directory: harnessDirectory(root), document: harnessIndexDocumentOf(emptyDocument(), 1) };
        const drifted: IoShardTarget = { kind: 'index', directory: unit.directory, file: path.join(unit.directory, 'indexjsn') };

        const reply = call({ kind: 'shard.save', callId: 9, target: drifted, unit, savedAt: 1 });

        expect(reply.kind).toBe('failure');

        const failure = reply as Extract<IoReply, { kind: 'failure' }>;

        expect(failure.error.code).toBe('shard-layout');
        expect(failure.error.path).toBe(drifted.file);
        expect(failure.error.message).toBe(`The index shard target ${drifted.file} does not match the unit this frame carries (${harnessShardFileOf(unit)}).`);
        expect(fs.existsSync(harnessDirectory(root))).toBe(false);
    });

    it('reports a failed commit with the message the inline save() throws', () => {
        // `<root>/occupied` is a regular file, so the database directory cannot be
        // created. The exact errno text differs by platform, so the assertion is equality
        // BETWEEN the two modes, which is the property that matters for the 500 body.
        // The document is empty on purpose: then both modes' first and only write is the
        // INDEX shard, so the messages must match without any normalization except the
        // root name.
        const workerRoot = tempRoot('blocked-worker');
        const inlineRoot = tempRoot('blocked-inline');

        fs.writeFileSync(path.join(workerRoot, 'occupied'), 'x', 'utf8');
        fs.writeFileSync(path.join(inlineRoot, 'occupied'), 'x', 'utf8');

        const blockedDirectory = path.join(workerRoot, 'occupied', 'harness');
        const indexUnit: HarnessShardUnit = { kind: 'index', directory: blockedDirectory, document: harnessIndexDocumentOf(emptyDocument(), 1) };
        const reply = call({ kind: 'shard.save', callId: 10, target: targetOfUnit(indexUnit), unit: indexUnit, savedAt: 1 });

        expect(reply.kind).toBe('failure');

        let inlineMessage = '';
        const inlinePersistence = new HarnessPersistence(path.join(inlineRoot, 'occupied'));

        try {
            // Rooted at the occupied NAME, so the directory this writer wants to create
            // is `<occupied>/harness` - i.e. the same blocker the worker target hits.
            inlinePersistence.save(emptyDocument());
        } catch (error) {
            inlineMessage = error instanceof Error ? error.message : String(error);
        }

        // Same file spelling per mode, so the message texts must match byte for byte
        // once the root names are normalized. `split/join` replaces EVERY occurrence:
        // the mkdir path inside the cause mentions the same root a second time.
        const normalize = (value: string, root: string): string => value.split(root).join('<root>');
        const report = (reply as Extract<IoReply, { kind: 'failure' }>).error;
        const workerMessage = report.message;

        // The report carries BOTH texts on purpose: `message` is what a thrown error
        // says (a 500 body), `cause` is what `persistence.lastWriteError` says (the raw
        // failure), and the two differ by exactly the wrapper (../persistence.ts `causeOf`).
        expect(report.cause).toBe((inlinePersistence.lastWriteError as string).split(inlineRoot).join(workerRoot));

        // The comparison is only meaningful if the inline writer really failed too.
        expect(inlineMessage).not.toBe('');
        expect(normalize(workerMessage, workerRoot)).toBe(normalize(inlineMessage, inlineRoot));
        // The prefix is the actionable half: the file, and which stage of the commit
        // failed. The errno text after it is platform wording, already compared above.
        const indexFile = harnessShardFileOf(indexUnit);

        expect(workerMessage.startsWith(`${indexFile}: Could not create the harness database directory: `)).toBe(true);
        expect(fs.existsSync(indexFile)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// The worker-side skip gate
// ---------------------------------------------------------------------------
//
// In worker mode the digest check CAN only live here: `runShardSave` is the function that holds the
// serialized bytes (moving the check to the coordinator would mean handing the payload back, which
// is the stringify this mode exists to avoid). These tests pin both conditions of the skip — the
// payload digest AND the file witness — plus the two forget rules that keep the map honest.
describe('the worker-side skip gate', () => {
    it('writes a shard once, skips the identical payload, and writes again when the payload moves', () => {
        const root = tempRoot('skip-gate');
        const savedAt = 1_700_000_001_000;
        const first = unitsOf(root, document('one'), savedAt);
        const sessionFile = harnessShardFileOf(first.session);

        const written = unwrap(shardCall(40, first.session, savedAt));

        // A write says NOTHING about skipping — the flag is additive, so its absence is the normal
        // answer and a client that ignores the flag still reads every reply correctly.
        expect(written.skipped).toBeUndefined();

        const bytes = fs.readFileSync(sessionFile, 'utf8');
        const witness = fs.statSync(sessionFile);

        const skipped = unwrap(shardCall(41, first.session, savedAt));

        expect(skipped.skipped).toBe(true);
        // The OUTCOME is unchanged: the file a reader needs is on disk either way, which is why no
        // caller branches on the flag and no durability meaning moves.
        expect(skipped.outcome).toBe('durable');
        // The measurement is still reported — the client's per-path size guard is about how big the
        // shard IS, and a skip does not change that.
        expect(skipped.bytes).toBe(bytes.length);
        // Nothing touched the file: same inode, same bytes, and no staging leftover.
        expect(fs.statSync(sessionFile).ino).toBe(witness.ino);
        expect(fs.readFileSync(sessionFile, 'utf8')).toBe(bytes);
        expect(fs.readdirSync(first.session.directory)).toEqual([HARNESS_SESSION_FILE]);

        // A payload that MOVED is written again: the gate is a byte test, not "have we seen this
        // session before". (`document('two')` changes the turn id, which lives in the record.)
        const moved = unitsOf(root, document('two'), savedAt);
        const rewritten = unwrap(shardCall(42, moved.session, savedAt));

        expect(rewritten.skipped).toBeUndefined();
        expect(fs.readFileSync(sessionFile, 'utf8')).toBe(serializeHarnessShard(moved.session));
        expect(fs.statSync(sessionFile).ino).not.toBe(witness.ino);
    });

    it('restores its own bytes when someone edits the file behind the digest (the v1 self-heal)', () => {
        // The hole a digest-only gate opens, and the reason the skip has a second condition. The
        // hash is of the WRITER's bytes, which did not change, so only the file witness can see an
        // edit made from outside this process. Inline mode self-heals by rewriting the whole
        // document on every commit; this is the per-shard equivalent of that.
        const root = tempRoot('skip-self-heal');
        const savedAt = 1_700_000_001_010;
        const units = unitsOf(root, document('one'), savedAt);
        const threadFile = harnessShardFileOf(units.thread);

        unwrap(shardCall(43, units.thread, savedAt));

        const pristine = fs.readFileSync(threadFile, 'utf8');

        // A DIFFERENT BYTE LENGTH that is still the same JSON document, so the witness moves with
        // the edit whatever granularity this filesystem reports for `mtimeMs`.
        fs.writeFileSync(threadFile, `${pristine}\n`, 'utf8');
        expect(JSON.parse(fs.readFileSync(threadFile, 'utf8'))).toEqual(JSON.parse(pristine));

        const healed = unwrap(shardCall(44, units.thread, savedAt));

        expect(healed.skipped).toBeUndefined();
        expect(fs.readFileSync(threadFile, 'utf8')).toBe(pristine);

        // And the healed state is remembered, so the next identical save skips again rather than
        // rewriting on every commit.
        expect(unwrap(shardCall(45, units.thread, savedAt)).skipped).toBe(true);
    });

    it('re-creates a shard that was deleted behind its own digest entry', () => {
        // The other half of the witness rule: a file that cannot be statted at all counts as
        // CHANGED. Skipping there would leave the conversation with no transcript behind a digest
        // claiming it exists — and nothing would ever write it again.
        const root = tempRoot('skip-deleted');
        const savedAt = 1_700_000_001_020;
        const units = unitsOf(root, document('one'), savedAt);
        const threadFile = harnessShardFileOf(units.thread);

        unwrap(shardCall(46, units.thread, savedAt));

        const pristine = fs.readFileSync(threadFile, 'utf8');

        fs.rmSync(threadFile);

        const healed = unwrap(shardCall(47, units.thread, savedAt));

        expect(healed.skipped).toBeUndefined();
        expect(fs.readFileSync(threadFile, 'utf8')).toBe(pristine);
    });
});

// ---------------------------------------------------------------------------
// shard.erase — the removal leg worker mode was missing
// ---------------------------------------------------------------------------
//
// Inline `save()` erases the shards its header stopped naming (../persistence.ts
// `eraseVanishedShards`). A worker-mode coordinator that only POSTED WRITES could not do that at
// all, so a session dropped from the document left its `session.json` and transcripts on disk
// forever. The frame carries absolute paths (the worker owns no layout), erases best-effort, and is
// posted UNAWAITED by the client — so it adds a durability action without adding a durability claim.
describe('shard.erase', () => {
    const eraseCall = (callId: number, target: IoShardTarget, files: readonly string[], trees: readonly string[]): IoReply =>
        call({ kind: 'shard.erase', callId, target, files, trees });

    // One session with the full footprint a strict commit leaves: transcript, record, index — plus
    // the journal, which the STORE owns and the persistence layer never writes or removes.
    const footprintOf = (root: string, savedAt: number, firstCallId: number) => {
        const units = unitsOf(root, document('one'), savedAt);
        const journal = journalTarget(root, 'session-1');

        unwrap(shardCall(firstCallId, units.thread, savedAt));
        unwrap(shardCall(firstCallId + 1, units.session, savedAt));
        unwrap(shardCall(firstCallId + 2, units.index, savedAt));
        unwrap(call({ kind: 'journal.append', callId: firstCallId + 3, target: journal, record: { turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'one', delta: 'kept' } } }));
        unwrap(call({ kind: 'journal.flush', callId: firstCallId + 4, target: journal }));

        return units;
    };

    it('removes a dropped session record and its threads, and keeps its events.jsonl', () => {
        const root = tempRoot('erase-dropped');
        const savedAt = 1_700_000_001_100;
        const directory = harnessDirectory(root);
        const units = footprintOf(root, savedAt, 50);
        const sessionDirectory = harnessSessionDirectoryOf(directory, 'session-1');
        const sessionFile = harnessSessionFileOf(directory, 'session-1');
        const threadsDirectory = harnessThreadDirectoryOf(directory, 'session-1');
        const journalFile = path.join(sessionDirectory, 'events.jsonl');

        expect(fs.existsSync(sessionFile)).toBe(true);
        expect(fs.existsSync(journalFile)).toBe(true);

        const reply = unwrap(eraseCall(55, targetOfUnit(units.session), [sessionFile], [threadsDirectory]));

        expect(reply.outcome).toBe('durable');
        // The exact footprint the inline collector removes...
        expect(fs.existsSync(sessionFile)).toBe(false);
        expect(fs.existsSync(threadsDirectory)).toBe(false);
        // ...and NOTHING else. The journal and the session directory are the store's footprint
        // ("row erased, journal kept", the outcome ./sessions.ts `remove()` relies on), and the
        // index of the surviving sessions is untouched.
        expect(fs.existsSync(journalFile)).toBe(true);
        expect(fs.existsSync(sessionDirectory)).toBe(true);
        expect(fs.existsSync(harnessShardFileOf(units.index))).toBe(true);
    });

    it('is idempotent, and forgets the stamp of everything it removed', () => {
        const root = tempRoot('erase-forget');
        const savedAt = 1_700_000_001_110;
        const directory = harnessDirectory(root);
        const units = footprintOf(root, savedAt, 60);
        const sessionFile = harnessSessionFileOf(directory, 'session-1');
        const threadsDirectory = harnessThreadDirectoryOf(directory, 'session-1');
        const target = targetOfUnit(units.session);

        unwrap(eraseCall(65, target, [sessionFile], [threadsDirectory]));

        const again = unwrap(eraseCall(66, target, [sessionFile], [threadsDirectory]));

        // A re-posted removal answers 'durable' with the files already gone: the shared primitive
        // uses `force: true`, so a missing path is a SUCCESS. The queue can therefore never turn a
        // completed cleanup into a failure.
        expect(again.outcome).toBe('durable');
        expect(again.bytes).toBeUndefined();

        // The stamps are gone with the files, so the same payloads are WRITTEN again rather than
        // skipped against bytes that are no longer there.
        const record = unwrap(shardCall(67, units.session, savedAt));
        const transcript = unwrap(shardCall(68, units.thread, savedAt));

        expect(record.skipped).toBeUndefined();
        expect(transcript.skipped).toBeUndefined();
        expect(fs.readFileSync(sessionFile, 'utf8')).toBe(serializeHarnessShard(units.session));
        expect(fs.existsSync(harnessShardFileOf(units.thread))).toBe(true);
    });

    it('removes only the transcript the record cap retired, and leaves its siblings', () => {
        // A retired conversation erases FILES, never the session's `threads/` directory — the other
        // conversations of a LIVE session stay exactly where they are.
        const root = tempRoot('erase-thread');
        const savedAt = 1_700_000_001_120;
        const directory = harnessDirectory(root);
        const units = unitsOf(root, document('one'), savedAt);
        const retired: HarnessShardUnit = { ...units.thread, id: 'thread-2', messages: [{ role: 'user', text: 'the retired one' }] };

        unwrap(shardCall(70, units.thread, savedAt));
        unwrap(shardCall(71, retired, savedAt));

        const reply = unwrap(eraseCall(72, targetOfUnit(retired), [harnessThreadFileOf(directory, 'session-1', 'thread-2')], []));

        expect(reply.outcome).toBe('durable');
        expect(fs.existsSync(harnessShardFileOf(retired))).toBe(false);
        expect(fs.existsSync(harnessShardFileOf(units.thread))).toBe(true);

        // Only THAT transcript's stamp was forgotten.
        expect(unwrap(shardCall(73, units.thread, savedAt)).skipped).toBe(true);
    });

    it('answers a failure naming the failing path, instead of a durable it did not earn', () => {
        const root = tempRoot('erase-failure');
        const savedAt = 1_700_000_001_130;
        const units = unitsOf(root, document('one'), savedAt);

        unwrap(shardCall(80, units.index, savedAt));

        // A path this process cannot remove at all. A null byte is chosen deliberately over an
        // errno-shaped failure (a read-only directory, an unreadable tree): those succeed for a root
        // user and differ per platform, while Node rejects this argument identically everywhere, so
        // the pin below is about the REPORT rather than about the filesystem.
        const blocked = `${path.join(harnessDirectory(root), 'ghost')}\u0000.json`;
        const reply = call({ kind: 'shard.erase', callId: 81, target: targetOfUnit(units.index), files: [blocked], trees: [] });

        expect(reply.kind).toBe('failure');

        const failure = reply as Extract<IoReply, { kind: 'failure' }>;

        expect(failure.error.code).toBe('shard-erase');
        expect(failure.error.path).toBe(blocked);

        // ONE `<path>: <reason>` entry per failure. The reason text belongs to Node, so the test
        // obtains it the same way the primitive does rather than hard-coding a sentence that changes
        // with the platform — and asserts the shape that matters: the removal is REPORTED, and the
        // subject of the report is the shard, not "the database".
        let reason = '';

        try {
            fs.rmSync(blocked, { force: true });
        } catch (error) {
            reason = error instanceof Error ? error.message : String(error);
        }

        expect(reason).not.toBe('');
        expect(failure.error.message).toBe(`Could not erase 1 shard a commit stopped naming: ${blocked}: ${reason}`);
        // Nothing else was removed, and the index the frame targeted is still there.
        expect(fs.existsSync(harnessShardFileOf(units.index))).toBe(true);
    });

    it('forgets the stamps under the session directory that journal.remove deleted', () => {
        // `journal.remove()` deletes the whole session directory, shard files included
        // (../journal.ts:505-510). A surviving stamp would make the next save of that id skip and
        // leave the shard missing — so the removal of a directory has to clear everything under it.
        const root = tempRoot('forget-on-remove');
        const savedAt = 1_700_000_001_140;
        const units = unitsOf(root, document('one'), savedAt);

        unwrap(shardCall(90, units.thread, savedAt));
        unwrap(call({ kind: 'journal.remove', callId: 91, target: journalTarget(root, 'session-1') }));

        expect(fs.existsSync(harnessShardFileOf(units.thread))).toBe(false);

        const rewritten = unwrap(shardCall(92, units.thread, savedAt));

        expect(rewritten.skipped).toBeUndefined();
        expect(fs.existsSync(harnessShardFileOf(units.thread))).toBe(true);
    });

    it('refuses an erase frame that does not name a path, and removes nothing', () => {
        const root = tempRoot('erase-frame');
        const savedAt = 1_700_000_001_150;
        const units = unitsOf(root, document('one'), savedAt);

        unwrap(shardCall(100, units.session, savedAt));

        const reply = call({ kind: 'shard.erase', callId: 101, target: targetOfUnit(units.session), files: [], trees: [] });

        // A frame that would remove nothing is a coordinator bug, and answering 'durable' for it
        // would report a cleanup that never happened (../io-protocol.ts `isIoOperationShape`).
        expect(reply.kind).toBe('fault');
        expect(fs.existsSync(harnessShardFileOf(units.session))).toBe(true);
    });
});

describe('journal operations', () => {
    it('opens once, writes the header, and appends every event in call order', () => {
        const root = tempRoot('journal-order');
        const target = journalTarget(root, 'sess-order');

        unwrap(call({ kind: 'journal.open', callId: 10, target }));

        const lines = ['a', 'b', 'c'];

        lines.forEach((delta, index) => {
            const reply = call({ kind: 'journal.append', callId: 11 + index, target, record: { turnId: 't1', index, at: 1_000 + index, event: { type: 'text', agent: 'one', delta } } });

            // 'written', not 'durable': the line is in the file through a held handle,
            // and only a flush fences it (./io-protocol.ts).
            expect(unwrap(reply).outcome).toBe('written');
        });

        expect(unwrap(call({ kind: 'journal.flush', callId: 20, target })).outcome).toBe('durable');

        const read = new HarnessJournal(path.join(root, 'harness'), 'sess-order').read();

        expect(read.missing).toBe(false);
        expect(read.problems).toEqual([]);
        expect(read.truncatedTail).toBe(false);
        expect(read.events.map((entry) => [entry.turnId, entry.index, entry.at, (entry.event as { delta?: string }).delta])).toEqual([
            ['t1', 0, 1_000, 'a'],
            ['t1', 1, 1_001, 'b'],
            ['t1', 2, 1_002, 'c']
        ]);

        // The wire format is the store's own, line for line.
        const text = fs.readFileSync(path.join(target.root, 'sessions', 'sess-order', 'events.jsonl'), 'utf8');
        const header = text.split('\n')[0];

        expect(JSON.parse(header)).toEqual({ type: 'header', v: HARNESS_JOURNAL_VERSION, sessionId: 'sess-order', createdAt: expect.any(Number) });
        expect(text.split('\n')[1]).toBe(journalLine({ type: 'event', v: HARNESS_JOURNAL_VERSION, turnId: 't1', index: 0, at: 1_000, event: { type: 'text', agent: 'one', delta: 'a' } }).trimEnd());
    });

    it('keeps one append handle per session so ordering is the file order', () => {
        // Two sessions in one worker: each handle is separate, and the interleaved
        // calls still produce two per-session logs in call order.
        const root = tempRoot('journal-two-sessions');
        const first = journalTarget(root, 'sess-a');
        const second = journalTarget(root, 'sess-b');

        call({ kind: 'journal.append', callId: 30, target: first, record: { turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: 'a1' } } });
        call({ kind: 'journal.append', callId: 31, target: second, record: { turnId: 't2', index: 0, at: 2, event: { type: 'text', agent: 'a', delta: 'b1' } } });
        call({ kind: 'journal.append', callId: 32, target: first, record: { turnId: 't1', index: 1, at: 3, event: { type: 'text', agent: 'a', delta: 'a2' } } });

        expect(ioJournalKey(first)).toBe(`${first.root}\u0000sess-a`);

        expect(new HarnessJournal(first.root, 'sess-a').read().events.map((entry) => (entry.event as { delta?: string }).delta)).toEqual(['a1', 'a2']);
        expect(new HarnessJournal(second.root, 'sess-b').read().events.map((entry) => (entry.event as { delta?: string }).delta)).toEqual(['b1']);
    });

    it('compacts with rewrite, clears with truncate, and both are durable', () => {
        const root = tempRoot('journal-rewrite');
        const target = journalTarget(root, 'sess-rewrite');

        for (let index = 0; index < 3; index += 1) {
            call({ kind: 'journal.append', callId: 40 + index, target, record: { turnId: 't1', index, at: index, event: { type: 'text', agent: 'a', delta: `d${index}` } } });
        }

        expect(unwrap(call({ kind: 'journal.rewrite', callId: 44, target, records: [{ turnId: 't1', index: 0, at: 0, event: { type: 'text', agent: 'a', delta: 'd0' } }] })).outcome).toBe('durable');

        const compacted = new HarnessJournal(target.root, 'sess-rewrite').read();

        expect(compacted.events).toHaveLength(1);
        expect(compacted.events[0]).toEqual({
            type: 'event',
            v: HARNESS_JOURNAL_VERSION,
            turnId: 't1',
            index: 0,
            at: 0,
            event: { type: 'text', agent: 'a', delta: 'd0' }
        });

        expect(unwrap(call({ kind: 'journal.truncate', callId: 45, target })).outcome).toBe('durable');

        const cleared = new HarnessJournal(target.root, 'sess-rewrite').read();

        expect(cleared.empty).toBe(true);
        expect(cleared.missing).toBe(false);
        expect(cleared.problems).toEqual([]);
    });

    it('removes the log for a deleted session and reports it durable', () => {
        const root = tempRoot('journal-remove');
        const target = journalTarget(root, 'sess-remove');

        call({ kind: 'journal.append', callId: 50, target, record: { turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: 'x' } } });

        expect(unwrap(call({ kind: 'journal.remove', callId: 51, target })).outcome).toBe('durable');
        expect(fs.existsSync(path.join(target.root, 'sessions', 'sess-remove'))).toBe(false);

        // A later frame for the same session re-attaches (a recreated session), exactly
        // as the store's `attachJournal` does.
        call({ kind: 'journal.append', callId: 52, target, record: { turnId: 't2', index: 0, at: 2, event: { type: 'text', agent: 'a', delta: 'y' } } });

        const read = new HarnessJournal(target.root, 'sess-remove').read();

        expect(read.events.map((entry) => entry.turnId)).toEqual(['t2']);
    });

    it('reports a journal failure with the same text the inline handle reports', () => {
        // Two roots, one blocker each, ONE session id: the failure text embeds the mkdir
        // path, so the only way to compare the two modes exactly is to normalize the root
        // name. That comparison is the point - the store prefixes this string into its
        // report, and the report must not differ between modes.
        const root = tempRoot('journal-blocked');
        const inlineRoot = tempRoot('journal-blocked-inline');

        for (const blocked of [root, inlineRoot]) {
            // A regular file where the journal DIRECTORY must go: mkdir fails
            // deterministically on every platform (../journal.test.ts:244 uses the same
            // blocker), without needing permissions.
            fs.writeFileSync(path.join(blocked, 'harness'), 'occupied', 'utf8');
        }

        const target = journalTarget(root, 'sess-blocked');
        const reply = call({ kind: 'journal.append', callId: 60, target, record: { turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: 'x' } } });

        expect(reply.kind).toBe('failure');

        const failure = reply as Extract<IoReply, { kind: 'failure' }>;

        expect(failure.error.code).toBe('journal');
        expect(failure.error.path).toBe(path.join(target.root, 'sessions', 'sess-blocked', 'events.jsonl'));

        // The store reads `journal.error` inline and `journalError(id)` in worker mode;
        // the strings must be identical or its reporter drifts between modes.
        const inline = new HarnessJournal(path.join(inlineRoot, 'harness'), 'sess-blocked');

        inline.append({ turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: 'x' } });

        expect(inline.error).toBeTypeOf('string');
        expect(failure.error.message).toBe((inline.error as string).replace(inlineRoot, root));
        expect(failure.error.message).toContain('sess-blocked');
    });

    it('closes a handle without deleting the log, and drains every handle on shutdown', () => {
        // Declared last: `shutdown` fences and drops EVERY cached handle, so a later
        // test in this file could not rely on one still being open. The worker's handle
        // map is module state shared by this file's tests, so the drain count is
        // asserted relative to what this test found open - exact, and independent of the
        // unrelated tests that ran before it.
        const root = tempRoot('journal-close');
        const target = journalTarget(root, 'sess-close');
        const openBefore = ioWorkerOpenJournals();

        call({ kind: 'journal.append', callId: 70, target, record: { turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: 'kept' } } });

        expect(ioWorkerOpenJournals()).toBe(openBefore + 1);

        expect(unwrap(call({ kind: 'journal.close', callId: 71, target })).outcome).toBe('durable');

        // A close releases the handle but keeps the log, and the cached instance with it.
        expect(ioWorkerOpenJournals()).toBe(openBefore);

        const afterClose = new HarnessJournal(target.root, 'sess-close').read();

        expect(afterClose.events.map((entry) => (entry.event as { delta?: string }).delta)).toEqual(['kept']);

        call({ kind: 'journal.append', callId: 72, target, record: { turnId: 't1', index: 1, at: 2, event: { type: 'text', agent: 'a', delta: 'tail' } } });

        expect(call({ kind: 'shutdown', callId: 73, reason: 'test' })).toEqual({ kind: 'bye', callId: 73, ok: true, drained: openBefore + 1 });
        expect(ioWorkerOpenJournals()).toBe(0);

        // The tail written without an explicit flush survived the shutdown drain, which
        // is the whole point of fencing handles on the way out.
        expect(new HarnessJournal(target.root, 'sess-close').read().events.map((entry) => (entry.event as { delta?: string }).delta)).toEqual(['kept', 'tail']);
    });
});

describe('the message loop', () => {
    it('answers every frame it is given and releases the port after a shutdown', () => {
        const root = tempRoot('loop');
        const received: IoReply[] = [];
        const closed: string[] = [];
        const port = {
            on: (_event: 'message', listener: (data: unknown) => void) => {
                (port as unknown as { listener: (data: unknown) => void }).listener = listener;

                return port;
            },
            postMessage: (reply: IoReply) => received.push(reply),
            close: () => closed.push('closed'),
            listener: undefined as unknown as (data: unknown) => void
        };

        runIoWorker(port as never);

        port.listener({ kind: 'hello', callId: 0 });
        port.listener({ kind: 'journal.open', callId: 1, target: journalTarget(root, 'sess-loop') });
        port.listener({ kind: 'shutdown', callId: 2 });

        expect(received.map((reply) => reply.kind)).toEqual(['hello', 'result', 'bye']);
        expect((received[1] as IoResult).outcome).toBe('written');
        expect((received[2] as Extract<IoReply, { kind: 'bye' }>).drained).toBe(1);
        // A shutdown releases the port so the thread can exit without a terminate call.
        expect(closed).toEqual(['closed']);
    });
});

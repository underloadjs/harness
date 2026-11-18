// Worker IO end to end, over a REAL worker thread (R1/R2/R4/R5 acceptance).
//
// Every test here drives the coordinator-side client against an ACTUAL spawned worker running
// the package's OWN entry: `src/server/workers/io-worker.ts`, loaded by the thread through
// Vite's module runner (./worker-boot.mjs + ./worker-runner.ts). There is no built bundle in
// this package's publishing model, so the suite exercises the only path that exists - which is
// exactly the integration the build owner depends on.
//
// What is asserted, and why it is the acceptance list:
//   - ordered shard commit (R5): one document becomes `<dir>/index.json` plus one
//     `session.json` and one file per thread, posted threads-first (the journal fence
//     lands before the first rename), and a coalesced burst posts one frame PER PATH in
//     that same order - the queue, not the caller, guarantees it,
//   - error propagation: a refused write rejects with the message the inline writer
//     throws (no false success), the sticky error channel describes the FIRST failing
//     shard (inline parity), and a queued write reports through the inline error
//     channels (no silent loss),
//   - per-path accounting (R5): supersession, size measurement and refusal are tracked
//     per SHARD FILE, so one oversized conversation neither freezes the other shards nor
//     hides behind a composite number,
//   - close: outstanding work is fenced, later work is refused rather than dropped,
//   - round-trip load: the bytes the worker wrote are read back by the store's own
//     `HarnessPersistence.load()` / `HarnessJournal.read()`, with no worker involved.
//
// Durability claims are checked as STATED, never relaxed: an append answers 'written',
// a flush and every shard save answer 'durable' (./io-protocol.ts).

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HarnessJournal } from '../journal';
import {
    HARNESS_DATABASE_VERSION,
    HARNESS_INDEX_FILE,
    HarnessPersistence,
    harnessIndexDocumentOf,
    harnessSessionDirectoryOf,
    harnessSessionFileOf,
    harnessShardFileOf,
    harnessThreadDirectoryOf,
    harnessThreadFileOf,
    serializeHarnessShard,
    splitHarnessSessionRecord
} from '../persistence';
import type { HarnessDatabase } from '../persistence';
// The snapshot version a session's `core` must carry, asserted by the loader this client's
// commits are read back through (../persistence.ts `requireCoreSnapshotVersion` ->
// ../../core/snapshot.ts `HARNESS_SNAPSHOT_VERSION`). These suites only ever WRITE shards and
// prove a plain `HarnessPersistence.load()` can read them, so their hand-built cores used to
// carry an arbitrary `version: 1`; that number is now part of the read contract, and pinning
// the constant keeps this file honest the day the kernel bumps the snapshot.
import { HARNESS_SNAPSHOT_VERSION } from '../../core/snapshot';
import {
    HarnessIoError,
    IO_WORKER_PACKAGE_SPECIFIER,
    createHarnessIoClient,
    ioWorkerEntryCandidates,
    openHarnessIoClient,
    resolveIoWorkerEntry
} from './io-client';
import type { HarnessIoClient, HarnessIoClientOptions } from './io-client';
import { harnessRunnerServerStarted } from './worker-runner';

// One directory deeper than ../journal.test.ts (src/server/workers), so the package
// root is three levels up. Scratch still belongs in the REPO-root Temp/.
const PACKAGE_ROOT = path.resolve(__dirname, '../../..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const roots: string[] = [];
const clients: HarnessIoClient[] = [];

// The entry every suite here spawns: the package's own TypeScript entry, loaded by the
// thread through the Vite module runner (./worker-boot.mjs). It is an explicit override only
// so the suite is independent of the resolver chain - which its own tests assert below.
const entry = path.resolve(__dirname, 'io-worker.ts');

const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-io-client-${label}-`));

    roots.push(root);

    return root;
};

// Path literals inside an expected MESSAGE need escaping before they go into a RegExp -
// the refusal sentences quote the shard file, and a path is full of regex syntax.
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The persistence TARGET this client is handed, spelled the way v2's `HarnessPersistence`
// spells it: `file` is the index header, and it is only the subject of operator-facing
// messages - every shard path comes from A1's layout primitives (the helpers below).
const target = (root: string): { directory: string; file: string } => {
    const directory = path.join(root, 'harness');

    return { directory, file: path.join(directory, HARNESS_INDEX_FILE) };
};

// The store's own reader is the judge of these records: `definition`/`preset` carry
// every field `readDescriptor`/`readPresetRecord` requires, and `usage.total` is
// mandatory. A document that fails that check would not prove the restart path works.
const PRESET = {
    name: 'live',
    title: 'Live',
    description: 'd',
    requiresEndpoint: false,
    // R11's clean break, stated in the STORED shape: `entry` (the routing agent) and `ranks`
    // (agent id -> rank letter) replace the retired `primary`/`subagents` pair, and the reader
    // REQUIRES both (../persistence.ts `readPresetRecord`/`readDescriptor`), refusing the old keys
    // outright rather than translating them. A fixture that still wrote `primary` would be rejected
    // by the store's own reader before the durability behaviour under test could run at all.
    entry: 'a',
    // `as const` keeps the rank letter a LITERAL. PRESET is declared on its own and only ever
    // SPREAD into the session row below (`preset: { ...PRESET }`), so `ranks` gets no contextual
    // type from `HarnessPresetRecord` and a bare 'A' would widen to `string`, which
    // `Record<string, AgentRank>` refuses (../types/index.ts:1469 `AgentRank` is the A–Z letter
    // union; ../persistence.ts:294 is the field). This is the same reason `template` below carries
    // `as const`, and the spelling the sibling suites already use for the same reason
    // (../background.test.ts:181, ../../harness.thread-epoch.test.ts:132).
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

// R5: the conversation content lives in `core.threads[]` - the rows A1's splitter moves
// into `threads/<id>.json`. The id matches `HARNESS_THREAD_ID_PATTERN`, so the transcript
// DOES split into its own shard (a foreign id would stay inline, and these tests would
// silently stop covering the thread file).
const document = (marker: string, events = 0): HarnessDatabase => ({
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
                    events: Array.from({ length: events }, (_, index) => ({ type: 'text', agent: 'a', delta: `${marker}-${index}` }) as never)
                }
            ],
            queue: [],
            core: {
                // NOT a free number any more: the loader asserts the snapshot version (see the
                // import of `HARNESS_SNAPSHOT_VERSION` above).
                version: HARNESS_SNAPSHOT_VERSION,
                agents: {},
                memory: {},
                threads: [{ id: 'thread-1', title: 't', messages: [{ role: 'user', text: `transcript-${marker}` }] }]
            } as never
        }
    ]
});

// The three shard files of `document(...)` for one root, derived through A1's own layout
// primitives - the tests pin WHERE the client wrote, so the expectation must come from the
// layout owner, not from a re-spelled literal.
const shardFiles = (root: string): { index: string; session: string; thread: string } => {
    const directory = path.join(root, 'harness');

    return {
        index: path.join(directory, HARNESS_INDEX_FILE),
        session: harnessShardFileOf({ kind: 'session', directory: harnessSessionDirectoryOf(directory, 'session-1') } as never),
        thread: harnessShardFileOf({ kind: 'thread', directory: harnessThreadDirectoryOf(directory, 'session-1'), id: 'thread-1', messages: [] } as never)
    };
};

// The EXACT bytes each shard must hold for one document - the same units the client's
// split builds, serialized by the same serializer the worker uses. Keyed by shard file.
const shardTexts = (root: string, doc: HarnessDatabase, savedAt: number): Record<string, string> => {
    const files = shardFiles(root);
    const { record: stored } = splitHarnessSessionRecord(doc.sessions[0]);
    const marker = doc.sessions[0].turns[0].id.replace('turn-', '');

    return {
        [files.thread]: serializeHarnessShard({ kind: 'thread', directory: path.dirname(files.thread), sessionId: 'session-1', id: 'thread-1', messages: [{ role: 'user', text: `transcript-${marker}` }] }),
        [files.session]: serializeHarnessShard({ kind: 'session', directory: path.dirname(files.session), sessionId: 'session-1', record: stored }),
        [files.index]: serializeHarnessShard({ kind: 'index', directory: path.dirname(files.index), document: harnessIndexDocumentOf(doc, savedAt) })
    };
};

const openClient = async (root: string, options: Partial<HarnessIoClientOptions> = {}): Promise<HarnessIoClient> => {
    const client = await createHarnessIoClient({ persistence: target(root), entry, ...options });

    clients.push(client);

    return client;
};

beforeAll(() => {
    // No build step: the entry is the module the runner imports. If this file is missing,
    // worker IO cannot start at all, and the failure should name the entry rather than
    // surface as a handshake timeout in every test below.
    expect(fs.existsSync(entry)).toBe(true);
});

afterAll(async () => {
    for (const client of clients) {
        await client.close().catch(() => undefined);
    }

    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe('startup', () => {
    it('spawns the source entry through the Vite runner and speaks the protocol before doing any work', async () => {
        const client = await openClient(tempRoot('start'));

        expect(client.entry).toBe(entry);
        // AC8: proof that the thread really loaded a `.ts` entry through the Vite module
        // runner. The entry ends in `.ts` (raw Node cannot even parse that), and the shared
        // runner server exists - it is created ONLY by `openHarnessWorkerSession`, so a
        // silent fallback to some other loader would leave it false while the round trip
        // below (the handshake) still succeeded.
        expect(entry.endsWith('.ts')).toBe(true);
        expect(harnessRunnerServerStarted()).toBe(true);
        expect(client.isOpen()).toBe(true);
        // `hello` is a control frame, not an operation: until it is answered the client
        // has performed no work, so every operation counter is still zero (a worker that
        // starts and dies mid-import must fail startup, not queue into a dead port).
        expect(client.stats()).toEqual({
            posted: 0,
            completed: 0,
            failed: 0,
            faults: 0,
            superseded: 0,
            supersededByPath: {},
            refused: 0,
            late: 0,
            writtenBytes: 0,
            // A skip is a worker answer, and the worker has answered nothing yet — `hello` is a
            // control frame. This is the counter that separates "the store saved and the disk
            // barely moved" (skips) from "the store saved and the disk moved a lot" (writes).
            skippedShards: 0,
            // R5: size accounting is PER SHARD FILE, and both maps start empty - no shard
            // has been measured or written yet. `hello` is a control frame, not an
            // operation, so the same reasoning that keeps `posted` at 0 keeps these empty.
            lastShardBytes: {},
            lastShardDurationMs: 0,
            // Per-kind posting starts empty for the same reason `posted` is 0: `hello` is a
            // control frame, so nothing has left this thread yet.
            postedByKind: {},
            outstanding: 0
        });
    });

    it('takes the entry from HARNESS_IO_WORKER_ENTRY when no option is given', async () => {
        // The operator escape hatch, exercised through the resolver rather than assumed.
        const root = tempRoot('env-entry');

        const client = await createHarnessIoClient({ persistence: target(root), entry: undefined, env: { HARNESS_IO_WORKER_ENTRY: entry } });

        clients.push(client);

        expect(client.entry).toBe(entry);

        const receipt = await client.saveCheckpoint(document('env'), { savedAt: 1 });

        expect(receipt.outcome).toBe('durable');
    });

    it('fails with a named reason when an entry is missing, never inline', async () => {
        const root = tempRoot('missing-entry');
        const missing = path.join(root, 'no-such-worker.mjs');

        await expect(createHarnessIoClient({ persistence: target(root), entry: missing })).rejects.toThrow(/worker-entry-missing|does not exist/);

        try {
            await createHarnessIoClient({ persistence: target(root), entry: missing });
        } catch (error) {
            expect(error).toBeInstanceOf(HarnessIoError);
            expect((error as HarnessIoError).code).toBe('worker-entry-missing');
            // The message has to tell an operator what to emit and how to point
            // elsewhere; a bare ENOENT would not.
            expect((error as HarnessIoError).message).toContain(missing);
            expect((error as HarnessIoError).message).toContain('HARNESS_IO_WORKER_ENTRY');
            expect((error as HarnessIoError).message).toContain(IO_WORKER_PACKAGE_SPECIFIER);
        }

        expect(resolveIoWorkerEntry({ entry }).path).toBe(entry);
        // An override is reported as `explicit` whatever its extension: every entry - `.ts`
        // or otherwise - is now loaded through the runner, so the extension no longer selects
        // a loader (there is only one).
        expect(resolveIoWorkerEntry({ entry }).mode).toBe('explicit');
        expect(resolveIoWorkerEntry({ entry: path.resolve(__dirname, 'io-worker.ts') }).mode).toBe('explicit');
        expect(() => resolveIoWorkerEntry({ env: { HARNESS_IO_WORKER_ENTRY: path.join(root, 'gone.mjs') } })).toThrow(/HARNESS_IO_WORKER_ENTRY points at a file that does not exist/);
    });

    it('opens synchronously and releases operations issued before the handshake', async () => {
        // WHY THIS EXISTS: `createHarnessRuntime` (../runtime.ts:107) and `new SessionStore`
        // (../sessions.ts:1321) are synchronous, so worker mode has to be constructible
        // without awaiting. `openHarnessIoClient` returns the client immediately and holds
        // every frame issued during startup behind the handshake gate, in call order.
        const root = tempRoot('sync-open');

        const client = openHarnessIoClient({ persistence: target(root), entry });

        clients.push(client);

        const save = client.saveCheckpoint(document('early'), { savedAt: 1_700_000_000_006 });

        client.queueJournalAppend('sess-early', { turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: 'early' } });

        // Nothing has reached the port yet: every operation is registered, not written.
        // R5: the strict save is THREE frames (thread, session, index), so a v1 pair of
        // operations is now four - and `measuredShards` is still 0 because no worker has
        // measured anything yet.
        expect(client.pending()).toEqual({ operations: 4, gated: 4, coalescedShards: 0, measuredShards: 0 });
        expect(client.stats().posted).toBe(0);

        await client.ready();

        expect((await save).outcome).toBe('durable');
        await client.barrier();

        expect(client.stats().posted).toBe(4);
        expect(client.pending()).toEqual({ operations: 0, gated: 0, coalescedShards: 0, measuredShards: 3 });
        expect(new HarnessPersistence(root).load()?.sessions[0]?.turns[0]?.id).toBe('turn-early');
        expect(new HarnessJournal(path.join(root, 'harness'), 'sess-early').read().events).toHaveLength(1);
    });

    it('runs the .ts entry end to end, so dev and test need no build', async () => {
        // The one load path that exists: `src/**.ts` through the runner. If this breaks,
        // worker IO cannot run under `vite-node` (the dev path this migration exists for),
        // and there is no built-entry fallback left to catch it.
        const root = tempRoot('source-entry');
        const sourceEntry = path.resolve(__dirname, 'io-worker.ts');

        const client = await createHarnessIoClient({ persistence: target(root), entry: sourceEntry });

        clients.push(client);

        expect(client.entry).toBe(sourceEntry);

        const saved = await client.saveCheckpoint(document('source'), { savedAt: 1_700_000_000_005 });

        expect(saved.outcome).toBe('durable');

        const appended = await client.journalAppend('sess-source', { turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: 'src' } });

        expect(appended.outcome).toBe('written');
        expect((await client.journalFlush('sess-source')).outcome).toBe('durable');

        expect(new HarnessPersistence(root).load()?.sessions[0]?.turns[0]?.id).toBe('turn-source');
        expect(new HarnessJournal(path.join(root, 'harness'), 'sess-source').read().events).toHaveLength(1);

        expect(await client.close()).toEqual({ drained: 1, failures: [] });
    });

    it('lists the resolution chain a checkout and a published src/ install both satisfy', () => {
        const candidates = ioWorkerEntryCandidates();

        expect(candidates[0]).toEqual({ path: '@underload/harness/io-worker', mode: 'package' });
        // The published subpath, then the entry beside this module. There is no `dist/` arm:
        // this package publishes TypeScript source, and the runner loads it directly.
        expect(candidates.map((candidate) => candidate.mode)).toEqual(['package', 'source']);
        expect(candidates[1].path).toBe(path.resolve(__dirname, 'io-worker.ts'));
        expect(candidates.length).toBe(2);
    });

    it('resolves the entry the way a checkout is laid out right now', async () => {
        // With no override at all the resolver must find a real `.ts` entry (the published
        // package subpath or the file beside `io-client.ts`) or fail naming every candidate.
        // Both branches are assertions; hard-coding one would make the suite depend on how
        // this repo's workspace links happen to be laid out.
        const root = tempRoot('default-entry');

        let resolved: string | undefined;
        let code: string | undefined;

        try {
            const client = await createHarnessIoClient({ persistence: target(root), env: {} });

            resolved = client.entry;

            await client.close();
        } catch (error) {
            code = (error as HarnessIoError).code;
            expect(code).toBe('worker-entry-missing');

            // The failure names every place it looked, so an operator can fix the
            // deployment without reading the source. The package specifier is listed both
            // as a `require.resolve(...)` attempt and in the help sentence.
            for (const candidate of ioWorkerEntryCandidates()) {
                expect((error as HarnessIoError).message).toContain(candidate.path);
            }
        }

        // AC8 again, from the other side: the DEFAULT resolution is a `.ts` module - the
        // runner's entry - not a bundle and not a flag-enabled Node mode.
        if (resolved !== undefined) expect(resolved.endsWith(`${path.sep}io-worker.ts`)).toBe(true);
    });
});

describe('durable checkpoint', () => {
    it('writes bytes the inline reader loads back unchanged', async () => {
        const root = tempRoot('roundtrip');
        const client = await openClient(root);
        const savedAt = 1_700_000_000_002;
        const doc = document('worker');

        const receipt = await client.saveCheckpoint(doc, { savedAt });

        const files = shardFiles(root);
        const texts = shardTexts(root, doc, savedAt);

        // The resolved promise carries the TERMINAL unit - the `index.json` write that
        // makes the whole commit load-bearing - and it names the file it committed. The
        // thread (call 1) and session (call 2) frames went out first, in `IO_SHARD_ORDER`,
        // and each got its own durable receipt inside the commit.
        expect(receipt).toEqual({
            callId: 3,
            kind: 'shard.save',
            outcome: 'durable',
            durationMs: expect.any(Number),
            bytes: texts[files.index].length,
            path: files.index
        });

        // Restart semantics: a FRESH persistence instance over the same root, no worker.
        const loaded = new HarnessPersistence(root).load();

        expect(loaded?.savedAt).toBe(savedAt);
        expect(loaded?.sessions[0]?.turns[0]?.id).toBe('turn-worker');
        // The transcript came back from ITS OWN file - the split round-trips.
        expect((loaded?.sessions[0]?.core as unknown as { threads: { id: string; messages: unknown }[] }).threads[0].messages).toEqual([
            { role: 'user', text: 'transcript-worker' }
        ]);

        // The atomic replacements left nothing staging behind, and EVERY shard file is
        // byte-identical to what the inline writer produces for the same unit - the
        // property that keeps both write modes readable by each other.
        expect(fs.readdirSync(target(root).directory).sort()).toEqual([HARNESS_INDEX_FILE, 'sessions']);

        for (const [file, text] of Object.entries(texts)) expect(fs.readFileSync(file, 'utf8')).toBe(text);

        // Per-path accounting: exactly the three shards were measured, each with its own
        // true size - no composite number exists anywhere.
        expect(client.stats().lastShardBytes).toEqual({
            [files.thread]: texts[files.thread].length,
            [files.session]: texts[files.session].length,
            [files.index]: texts[files.index].length
        });
        expect(client.stats().writtenBytes).toBe(Object.values(texts).reduce((total, text) => total + text.length, 0));

        const summary = await client.close();

        expect(summary).toEqual({ drained: 0, failures: [] });
    });

    it('rejects with the exact message the inline save() throws when the disk refuses', async () => {
        // `<root>/occupied` is a regular file, so the database directory cannot be
        // created. The assertion is the MESSAGE EQUALITY between the two modes: that is
        // what stops worker mode from reporting a different 500 than inline does.
        const workerRoot = tempRoot('reject-worker');
        const inlineRoot = tempRoot('reject-inline');

        fs.writeFileSync(path.join(workerRoot, 'occupied'), 'x', 'utf8');
        fs.writeFileSync(path.join(inlineRoot, 'occupied'), 'x', 'utf8');

        const client = await createHarnessIoClient({
            persistence: {
                directory: path.join(workerRoot, 'occupied', 'harness'),
                file: path.join(workerRoot, 'occupied', 'harness', HARNESS_INDEX_FILE)
            },
            entry
        });

        clients.push(client);

        const error = await client.saveCheckpoint(document('blocked')).then(() => undefined, (reason: unknown) => reason as HarnessIoError);

        expect(error).toBeInstanceOf(HarnessIoError);
        expect(error?.code).not.toBe('client-closed');

        let inlineMessage = '';
        const inlinePersistence = new HarnessPersistence(path.join(inlineRoot, 'occupied'));

        try {
            // Rooted at the occupied NAME, so the directory this writer wants is
            // `<occupied>/harness` - the same blocker the worker target hits. Without
            // this the comparison would be against a save that never failed.
            inlinePersistence.save(document('blocked'));
        } catch (reason) {
            inlineMessage = reason instanceof Error ? reason.message : String(reason);
        }

        expect(inlineMessage).not.toBe('');

        // The rejected message is the inline THROW, so the store's 500 body is unchanged
        // between modes (`Could not save the harness database: ${error.message}`,
        // ../sessions.ts:1957).
        expect(error?.message).toBe(inlineMessage.split(inlineRoot).join(workerRoot));

        // The two sticky channels, each matched to its own inline twin:
        //   - `persistence.lastWriteError` holds the RAW failure behind the wrapper
        //     (../persistence.ts, `causeOf`), and so does `lastError()` - NOT the wrapper
        //     text, which is what the rejection carries.
        expect(inlinePersistence.lastWriteError).toBeTypeOf('string');
        expect(client.lastError()).toBe((inlinePersistence.lastWriteError as string).split(inlineRoot).join(workerRoot));
        expect(error?.message.endsWith(client.lastError() as string)).toBe(true);

        const stats = client.stats();

        expect(stats.completed).toBe(0);
        // All THREE posted units hit the blocker - the queue could not know the first one
        // would fail. They are counted per operation, not folded into one composite
        // failure, and the rejection names the FIRST one, in posted order.
        expect(stats.failed).toBe(3);
        expect(stats.outstanding).toBe(0);

        // R5's parity rule for the sticky channel: the inline `save()` THROWS at its first
        // failing unit and never reaches the rest, so `lastError()`/`lastErrorPath()` must
        // describe THAT failure - the thread shard - even though the session and index
        // frames failed afterwards and are recorded under their own paths.
        expect(client.lastErrorPath()).toBe(path.join(workerRoot, 'occupied', 'harness', 'sessions', 'session-1', 'threads', 'thread-1.json'));
        expect(error?.path).toBe(path.join(workerRoot, 'occupied', 'harness', 'sessions', 'session-1', 'threads', 'thread-1.json'));
    });

    it('commits the shards that fit and refuses only the oversized one, per path', async () => {
        // R5 in one test: under v1 a 256-byte bound made the WHOLE database uncommittable.
        // Under R5 the same document splits, the fat session shard is refused with its own
        // name and measured size, and the small thread and index shards commit anyway -
        // reported per unit, never as a composite claim.
        const root = tempRoot('frame-bound');
        const client = await openClient(root, { maxFrameBytes: 256 });
        const files = shardFiles(root);
        const doc = document('huge', 200);

        await expect(client.saveCheckpoint(doc)).rejects.toThrow(new RegExp(`The session shard ${escapeRegex(files.session)} is \\d+ bytes, above the 256 byte IO frame limit\\.`));

        // Refused means the SESSION shard was not written - but the other two were, and
        // the per-path measurement is now in place so the next save of the same fat shard
        // is refused CLIENT-SIDE, without another clone of the oversized conversation.
        expect(fs.existsSync(files.session)).toBe(false);
        expect(fs.existsSync(files.thread)).toBe(true);
        expect(fs.existsSync(files.index)).toBe(true);

        expect(client.stats().refused).toBe(0); // the WORKER decided the first refusal
        expect(client.stats().failed).toBe(1);

        const measured = client.stats().lastShardBytes[files.session];

        expect(measured).toBeTypeOf('number');
        expect(client.lastErrorPath()).toBe(files.session);

        await expect(client.saveCheckpoint(doc)).rejects.toThrow(/measured \d+ bytes on its last measurement, above the 256 byte frame limit/);

        expect(client.stats().refused).toBe(1); // now the CLIENT refuses it, per path
        // A refusal is NOT a failure: the second save posted no frame for the oversized
        // path, so `failed` still only counts the ONE worker-side failure of the first
        // save (the v1 pair of counters keeps its distinct meanings under R5).
        expect(client.stats().failed).toBe(1);

        // A refusal never produced a worker reply, so the per-path measurement never shrinks
        // on its own - the SAME sticky guard v1 had, narrowed from the whole document to the
        // ONE path that was measured oversized. The siblings still commit under it, which is
        // the part v1 could not do: a 256-byte bound used to make the entire state
        // uncommittable, where now only the oversized shard is held back.
        const smaller = document('fit', 1);

        await expect(client.saveCheckpoint(smaller)).rejects.toThrow(/measured \d+ bytes on its last measurement, above the 256 byte frame limit/);

        expect(fs.existsSync(files.thread)).toBe(true);
        expect(fs.existsSync(files.index)).toBe(true);
        expect(fs.existsSync(files.session)).toBe(false);
        expect(client.lastErrorPath()).toBe(files.session);

        // The index header lists a session whose record file never arrived, so the store
        // cannot load this state - the same torn-set rule the inline writer reports
        // (../persistence.ts:2650).
        expect(() => new HarnessPersistence(root).load()).toThrow(/record file is missing/);

        // The measurement cache belongs to the CLIENT, not to the disk: a fresh client that
        // has never seen the fat shard commits the SAME path, at a bound exactly large
        // enough for the shard this document decomposes into.
        const fitTexts = shardTexts(root, smaller, 1_700_000_000_008);
        const fitBound = Math.max(...Object.values(fitTexts).map((text) => text.length));
        const fresh = await openClient(root, { maxFrameBytes: fitBound });

        await expect(fresh.saveCheckpoint(smaller, { savedAt: 1_700_000_000_008 })).resolves.toMatchObject({ outcome: 'durable' });

        for (const [file, text] of Object.entries(fitTexts)) expect(fs.readFileSync(file, 'utf8')).toBe(text);

        expect(new HarnessPersistence(root).load()?.sessions[0]?.turns[0]?.id).toBe('turn-fit');
    });

    it('refuses every oversized shard of one document and writes nothing at all', async () => {
        // The degenerate case: a bound below EVERY unit's size refuses all three paths.
        // Nothing is written, nothing claims durability, and the client-side guard then
        // refuses the whole request without posting a frame per path.
        const root = tempRoot('frame-bound-all');
        const client = await openClient(root, { maxFrameBytes: 64 });

        await expect(client.saveCheckpoint(document('huge', 200))).rejects.toThrow(/above the 64 byte IO frame limit/);

        expect(new HarnessPersistence(root).load()).toBeUndefined();
        expect(client.stats().refused).toBe(0);
        expect(client.stats().failed).toBe(3);

        await expect(client.saveCheckpoint(document('huge', 200))).rejects.toThrow(/measured \d+ bytes on its last measurement, above the 64 byte frame limit/);

        expect(client.stats().refused).toBe(3);
    });
});

describe('journal through the worker', () => {
    it('keeps every append in call order and fences it before the checkpoint', async () => {
        const root = tempRoot('ordered-commit');
        const client = await openClient(root);
        const sessionId = 'sess-order';

        const deltas = ['a', 'b', 'c', 'd'];

        deltas.forEach((delta, index) => {
            client.queueJournalAppend(sessionId, { turnId: 't1', index, at: 1_000 + index, event: { type: 'text', agent: 'a', delta } });
        });

        const committed = await client.commitCheckpoint({ document: document('ordered'), fenceSessions: [sessionId] });

        expect(committed.fenced).toEqual([sessionId]);
        expect(committed.checkpoint.outcome).toBe('durable');

        // R5: the commit receipt names EVERY shard it wrote, in posted (disk) order -
        // threads first, the session file that lists them second, the index last. The
        // `checkpoint` field is that terminal index write, not an unnamed composite.
        const files = shardFiles(root);

        expect(committed.units.map((unit) => unit.path)).toEqual([files.thread, files.session, files.index]);
        expect(committed.units.every((unit) => unit.outcome === 'durable')).toBe(true);
        expect(committed.checkpoint).toBe(committed.units[2]);

        const read = new HarnessJournal(path.join(root, 'harness'), sessionId).read();

        expect(read.problems).toEqual([]);
        expect(read.truncatedTail).toBe(false);
        expect(read.events.map((event) => [event.index, (event.event as { delta?: string }).delta])).toEqual([
            [0, 'a'],
            [1, 'b'],
            [2, 'c'],
            [3, 'd']
        ]);

        // Four appends, the commit's flush, then the commit's THREE shard frames (thread,
        // session, index - `IO_SHARD_ORDER`, posted after the flush so the fence lands
        // before the first rename). The handshake and the close frames are controls, not
        // operations, and are not counted (./io-client.ts).
        expect(client.stats().posted).toBe(8);
        expect(client.stats().completed).toBe(8);
        expect(client.stats().failed).toBe(0);
        // `postedByKind` is where "the fence was posted, and the commit was three shards,
        // in the order the disk must see" is a NUMBER an operator can read.
        expect(client.stats().postedByKind).toEqual({ 'journal.append': 4, 'journal.flush': 1, 'shard.save': 3 });
        expect(new HarnessPersistence(root).load()?.sessions[0]?.turns[0]?.id).toBe('turn-ordered');

        // An awaited append answers 'written', never 'durable': the append's own receipt
        // must not be mistaken for a durability claim (./io-protocol.ts).
        const append = await client.journalAppend(sessionId, { turnId: 't1', index: 4, at: 1_004, event: { type: 'text', agent: 'a', delta: 'e' } });

        expect(append.outcome).toBe('written');

        const flush = await client.journalFlush(sessionId);

        expect(flush.outcome).toBe('durable');

        expect(new HarnessJournal(path.join(root, 'harness'), sessionId).read().events).toHaveLength(5);
    });

    it('reports a queued append failure through the journal error channel', async () => {
        const root = tempRoot('journal-failure');

        fs.mkdirSync(path.join(root, 'harness'), { recursive: true });
        // A regular file where the per-session journal directories live: every mkdir for
        // a session fails, deterministically (../journal.test.ts:244 same blocker).
        fs.writeFileSync(path.join(root, 'harness', 'sessions'), 'occupied', 'utf8');

        const reported: [string, string][] = [];

        const client = await openClient(root, {
            onJournalError: (sessionId, message) => reported.push([sessionId, message])
        });

        client.queueJournalAppend('sess-blocked', { turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: 'x' } });

        // The queued path never throws at its caller (a recorder cannot react), so the
        // barrier is what surfaces the failure.
        await expect(client.barrier()).rejects.toThrow(/1 of 1 queued IO operations failed/);

        // Same root, SAME session id: the failure text embeds the mkdir path, so this is
        // the only spelling under which the two modes can be compared exactly. The store
        // reads `journal.error` inline and `journalError(id)` in worker mode, and prefixes
        // both with its own sentence, so the text may not drift.
        const inline = new HarnessJournal(path.join(root, 'harness'), 'sess-blocked');

        inline.append({ turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: 'x' } });

        expect(inline.error).toBeTypeOf('string');
        expect(reported).toEqual([['sess-blocked', inline.error as string]]);
        expect(client.journalError('sess-blocked')).toBe(inline.error);
        expect(client.journalFailures('sess-blocked')).toBe(1);
        expect(client.journalError('sess-never-touched')).toBeUndefined();
        expect(client.journalFailures('sess-never-touched')).toBe(0);
    });

    it('rewrites, truncates and removes a log on the worker thread', async () => {
        const root = tempRoot('journal-lifecycle');
        const client = await openClient(root);
        const sessionId = 'sess-lifecycle';

        for (let index = 0; index < 3; index += 1) {
            await client.journalAppend(sessionId, { turnId: 't1', index, at: index, event: { type: 'text', agent: 'a', delta: `d${index}` } });
        }

        const rewritten = await client.journalRewrite(sessionId, [{ turnId: 't1', index: 0, at: 0, event: { type: 'text', agent: 'a', delta: 'kept' } }]);

        expect(rewritten.outcome).toBe('durable');

        const journal = new HarnessJournal(path.join(root, 'harness'), sessionId);

        expect(journal.read().events.map((event) => (event.event as { delta?: string }).delta)).toEqual(['kept']);

        expect((await client.journalTruncate(sessionId)).outcome).toBe('durable');
        expect(journal.read().events).toEqual([]);
        expect(journal.read().missing).toBe(false);

        expect((await client.journalRemove(sessionId)).outcome).toBe('durable');
        expect(fs.existsSync(path.join(root, 'harness', 'sessions', sessionId))).toBe(false);
        expect(journal.read().missing).toBe(true);
    });

    it('fences the journal tail on close, so a late append survives the shutdown', async () => {
        const root = tempRoot('close-fence');
        const client = await openClient(root);
        const sessionId = 'sess-close';

        client.queueJournalAppend(sessionId, { turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: 'tail' } });

        const summary = await client.close();

        // `drained: 1` is the worker reporting it fenced exactly one held handle.
        expect(summary).toEqual({ drained: 1, failures: [] });
        expect(client.isOpen()).toBe(false);

        const read = new HarnessJournal(path.join(root, 'harness'), sessionId).read();

        expect(read.events.map((event) => (event.event as { delta?: string }).delta)).toEqual(['tail']);
        expect(read.problems).toEqual([]);

        // After close, new work is refused - not silently inline, and not silently lost.
        const errors: HarnessIoError[] = [];
        const late = await createHarnessIoClient({ persistence: target(root), entry, onCheckpointError: (error) => errors.push(error) });

        await late.close();

        late.queueCheckpointSave(document('after-close'));

        expect(late.stats().refused).toBe(1);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('The IO client is closed');

        await expect(late.saveCheckpoint(document('after-close'))).rejects.toThrow(/client-closed|is closed/);
        await expect(late.commitCheckpoint({ document: document('after-close'), fenceSessions: [sessionId] })).rejects.toThrow(/client-closed|is closed/);

        // A barrier over an empty queue resolves: nothing is outstanding to fail.
        await expect(late.barrier()).resolves.toBeUndefined();
    });

    it('fails an outstanding operation when the worker stops answering, and counts the late reply', async () => {
        // The watchdog is the deterministic stand-in for a wedged worker: the caller is
        // told, nothing is left waiting, and the reply that arrives afterwards is COUNTED
        // rather than ignored. `opTimeoutMs` is off by default, so a slow disk is never
        // turned into a false failure (./io-client.ts).
        const root = tempRoot('timeout');
        const client = await openClient(root, { opTimeoutMs: 1 });

        // R5 moved this test off `saveCheckpoint`: a shard is small and fast, so "the
        // first frame is still busy when the watchdog fires" is no longer something a
        // document size can guarantee. ONE journal append carrying a 32 MB event is: the
        // worker serializes, `writeSync`s and fsyncs that line synchronously, so the
        // single outstanding frame is definitely still busy when a 1ms watchdog fires.
        const heavy = 'x'.repeat(32 * 1024 * 1024);

        await expect(client.journalAppend('sess-slow', { turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: heavy } })).rejects.toThrow(/did not answer journal.append \(call 1\) within 1ms/);

        expect(client.stats().failed).toBe(1);
        expect(client.stats().outstanding).toBe(0);
        expect(client.stats().late).toBe(0);

        // The close round trip is the fence that proves the late reply was processed: the
        // worker answers frames in order, so `bye` cannot arrive before the result frame
        // it follows.
        const summary = await client.close();

        expect(summary.failures).toEqual([]);
        expect(client.stats().late).toBe(1);
        expect(client.stats().completed).toBe(0);

        // "Timed out" is not "lost": the line DID reach the file, and the reader — not the
        // receipt — is the judge.
        expect(new HarnessJournal(path.join(root, 'harness'), 'sess-slow').read().events).toHaveLength(1);
    });
});

describe('coalescing and barriers', () => {
    it('collapses a synchronous burst of best-effort checkpoints into one write per shard', async () => {
        const root = tempRoot('coalesce');
        const client = await openClient(root);

        // Five observer fires in one synchronous turn (a burst of `noteStateChange`):
        // under R5 each request SPLITS, and the newest payload wins PER SHARD PATH. The
        // deferred slot holds three entries (thread, session, index) - not one document -
        // and every earlier payload for the same path is superseded.
        for (const marker of ['one', 'two', 'three', 'four', 'five']) client.queueCheckpointSave(document(marker));

        expect(client.pending()).toEqual({ operations: 0, gated: 0, coalescedShards: 3, measuredShards: 0 });

        await client.barrier();

        // Five requests, four of them replaced before they ever left this thread: four
        // supersessions PER PATH, twelve in total.
        expect(client.stats().superseded).toBe(12);

        const files = shardFiles(root);

        expect(client.stats().supersededByPath).toEqual({
            [files.thread]: 4,
            [files.session]: 4,
            [files.index]: 4
        });

        // Five queued saves, THREE frames - one per path - and the coalescing is visible
        // in the counters that say what was dropped. The posted ORDER is `IO_SHARD_ORDER`,
        // not insertion order: the burst filled the map thread-first... it does, but an
        // out-of-order burst must still land disk-ordered, and the receipt order below is
        // how the test sees it.
        expect(client.stats().posted).toBe(3);
        expect(client.stats().postedByKind).toEqual({ 'shard.save': 3 });

        const loaded = new HarnessPersistence(root).load();

        expect(loaded?.sessions[0]?.turns[0]?.id).toBe('turn-five');
        // The surviving thread shard is the NEWEST transcript - a coalesced-away older
        // payload never reached the disk.
        expect((loaded?.sessions[0]?.core as unknown as { threads: { id: string; messages: { text: string }[] }[] }).threads[0].messages[0].text).toBe('transcript-five');
        expect(client.pending().coalescedShards).toBe(0);
    });

    it('supersedes deferred shards per path when a strict commit covers them', async () => {
        const root = tempRoot('strict-supersede-path');
        const client = await openClient(root);

        client.queueCheckpointSave(document('stale'));

        // A strict save of a DIFFERENT (smaller) document covers all three paths too: the
        // whole deferred map is subsumed, and it is counted per path.
        await client.saveCheckpoint(document('current'), { savedAt: 1_700_000_000_007 });

        const files = shardFiles(root);

        expect(client.stats().superseded).toBe(3);
        expect(client.stats().supersededByPath).toEqual({
            [files.thread]: 1,
            [files.session]: 1,
            [files.index]: 1
        });

        // Nothing was written twice: the stale document never reached the disk.
        expect(fs.readFileSync(files.session, 'utf8')).toContain('turn-current');
        expect(fs.readFileSync(files.thread, 'utf8')).toContain('transcript-current');
    });

    it('lets a strict save supersede the pending document but fences queued appends', async () => {
        const root = tempRoot('strict-supersede');
        const client = await openClient(root);
        const sessionId = 'sess-strict';

        client.queueJournalAppend(sessionId, { turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: 'first' } });
        client.queueCheckpointSave(document('stale'));

        const receipt = await client.saveCheckpoint(document('current'), { savedAt: 1_700_000_000_003 });

        expect(receipt.outcome).toBe('durable');
        // The queued save is now three shard writes, so superseding it counts three times.
        expect(client.stats().superseded).toBe(3);
        expect(new HarnessPersistence(root).load()?.sessions[0]?.turns[0]?.id).toBe('turn-current');

        // Order survived the coalescing: the append queued BEFORE the strict save ran
        // before it, which is what makes the awaited save a barrier.
        const read = new HarnessJournal(path.join(root, 'harness'), sessionId).read();

        expect(read.events).toHaveLength(1);
        expect((read.events[0].event as { delta?: string }).delta).toBe('first');
    });

    it('counts a refused queued append instead of dropping it', async () => {
        const root = tempRoot('queue-bound');
        const reported: string[] = [];

        const client = await openClient(root, {
            maxPendingOps: 2,
            onJournalError: (sessionId, message) => reported.push(`${sessionId}: ${message}`)
        });

        // Nothing has been answered yet, so the third queued append crosses the bound.
        client.queueJournalAppend('s', { turnId: 't1', index: 0, at: 0, event: { type: 'text', agent: 'a', delta: 'a' } });
        client.queueJournalAppend('s', { turnId: 't1', index: 1, at: 1, event: { type: 'text', agent: 'a', delta: 'b' } });
        client.queueJournalAppend('s', { turnId: 't1', index: 2, at: 2, event: { type: 'text', agent: 'a', delta: 'c' } });

        expect(client.stats().refused).toBe(1);
        expect(reported).toEqual(['s: The IO queue holds 2 operations, at the configured limit of 2.']);

        await client.barrier();

        const deltas = new HarnessJournal(path.join(root, 'harness'), 's').read().events.map((event) => (event.event as { delta?: string }).delta);

        expect(deltas).toEqual(['a', 'b']);
    });

    it('reports a worker fault without losing the operation that caused it', async () => {
        // A frame the worker considers garbage must fail ITS callId, and be counted:
        // otherwise a mysteriously stuck request is the only symptom.
        const root = tempRoot('fault');
        const client = await openClient(root);

        const rejects = await client.journalAppend('s', { turnId: '', index: 0, at: 0, event: {} }).then(() => undefined, (error: unknown) => error as HarnessIoError);

        expect(rejects?.code).toBe('io-fault');
        expect(rejects?.message).toContain('Unrecognized IO frame: kind="journal.append" callId=1');
        expect(client.stats().faults).toBe(1);
        expect(client.stats().lastFault).toBe(rejects?.message);

        // The queue stays usable after a fault, exactly as after a disk failure.
        const receipt = await client.journalFlush('s');

        expect(receipt.outcome).toBe('durable');
    });
});

describe('main-thread accounting', () => {
    it('reports the bytes and off-thread duration of the last checkpoint', async () => {
        // The two numbers the isolation promise is measured by: the coordinator paid a
        // clone, the worker paid the serialization and the syscalls, and the client can
        // show which was which.
        const root = tempRoot('accounting');
        const client = await openClient(root);

        const doc = document('big', 400);
        const savedAt = 1_700_000_000_004;

        await client.saveCheckpoint(doc, { savedAt });

        const stats = client.stats();
        // R5 measures PER SHARD FILE: the total is the sum of the three shard bodies, and
        // each path carries its own true byte count and its own off-thread duration.
        const files = shardFiles(root);
        const texts = shardTexts(root, doc, savedAt);
        const totalBytes = Object.values(texts).reduce((sum, text) => sum + text.length, 0);

        expect(stats.writtenBytes).toBe(totalBytes);
        expect(stats.lastShardBytes).toEqual({
            [files.thread]: texts[files.thread].length,
            [files.session]: texts[files.session].length,
            [files.index]: texts[files.index].length
        });
        // The duration stays "the last write" (v1 semantics); the per-shard durations ride
        // on each receipt the commit returns.
        expect(stats.lastShardDurationMs).toBeTypeOf('number');
        // The worker-side clock is monotonic and the writes are real, so the duration is
        // finite and plausible. `> 0` is not asserted: two syscalls can land in one coarse
        // clock tick, and pinning that would be machine-dependent.
        expect(stats.lastShardDurationMs).toBeLessThan(1_000);

        expect(client.pending().measuredShards).toBe(3);

        const onCheckpointError = vi.fn();
        const second = await openClient(root, { onCheckpointError });

        await second.saveCheckpoint(document('healthy'));

        // A success clears the sticky error, as `lastWriteError` does inline.
        expect(second.lastError()).toBeUndefined();
        expect(onCheckpointError).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Worker-mode parity for the two things inline `save()` does that a
// write-only queue cannot: NOT writing a shard whose bytes are already on
// disk, and REMOVING the shards a commit stopped naming.
// ---------------------------------------------------------------------------

describe('worker-mode skip and removal', () => {
    // `document(...)` covers one session with one conversation. These helpers vary the
    // SESSION set (a dropped session, a re-added one) and the CONVERSATION set (a transcript
    // retired by the 256-record cap), which are the two shapes of removal the store produces.
    const documentOf = (...sessions: { id: string; threads: string[] }[]): HarnessDatabase => ({
        version: HARNESS_DATABASE_VERSION,
        savedAt: 1,
        registry: [],
        sessions: sessions.map(({ id, threads }) => ({
            ...document(id).sessions[0],
            id,
            core: {
                version: HARNESS_SNAPSHOT_VERSION,
                agents: {},
                memory: {},
                threads: threads.map((threadId) => ({ id: threadId, title: 't', messages: [{ role: 'user', text: `transcript-${threadId}` }] }))
            }
        })) as never
    });

    const pathsOf = (root: string, sessionId: string, threadId = 'thread-1') => {
        const directory = path.join(root, 'harness');
        const sessionDirectory = harnessSessionDirectoryOf(directory, sessionId);

        return {
            record: harnessSessionFileOf(directory, sessionId),
            thread: harnessThreadFileOf(directory, sessionId, threadId),
            threads: harnessThreadDirectoryOf(directory, sessionId),
            // The journal is the STORE's footprint (./sessions.ts), never the header's.
            events: path.join(sessionDirectory, 'events.jsonl'),
            directory: sessionDirectory
        };
    };

    it('saves an unchanged document again without touching a byte, and says so in its own counters', async () => {
        // The digest skip is what worker mode had NOT replicated: inline compares the payload it is
        // about to write with the bytes it last committed, and so does the worker — but only the
        // worker can, because only the worker holds these bytes (the coordinator would have to hand
        // the payload back, which is the stringify this mode exists to move off the loop).
        const root = tempRoot('skip-accounting');
        const client = await openClient(root);
        const doc = document('same');
        const savedAt = 1_700_000_002_000;
        const files = shardFiles(root);
        const texts = shardTexts(root, doc, savedAt);
        const totalBytes = Object.values(texts).reduce((sum, text) => sum + text.length, 0);

        await client.saveCheckpoint(doc, { savedAt });

        const first = client.stats();
        const inodes = { thread: fs.statSync(files.thread).ino, session: fs.statSync(files.session).ino, index: fs.statSync(files.index).ino };

        expect(first.writtenBytes).toBe(totalBytes);
        expect(first.skippedShards).toBe(0);

        await client.saveCheckpoint(doc, { savedAt });

        const second = client.stats();

        // Three frames, three skips, and no byte written twice. `writtenBytes` counts what REACHED a
        // file in this process, so a skip adds nothing to it — and `skippedShards` is the number that
        // explains why `writtenBytes` did not move, which is the question an operator would otherwise
        // have to guess at.
        expect(second.skippedShards).toBe(3);
        expect(second.writtenBytes).toBe(totalBytes);
        expect(second.completed).toBe(6);
        expect(second.posted).toBe(6);
        expect(second.postedByKind).toEqual({ 'shard.save': 6 });

        for (const kind of ['thread', 'session', 'index'] as const) {
            expect(fs.statSync(files[kind]).ino).toBe(inodes[kind]);
        }

        // A payload that moved IS written again, and the counters separate the two cases instead of
        // merging them: `savedAt` lives only in the index, so exactly one shard changed.
        await client.saveCheckpoint(doc, { savedAt: savedAt + 1_000 });

        const third = client.stats();

        expect(third.skippedShards).toBe(5);
        expect(third.writtenBytes).toBe(totalBytes + texts[files.index].length);
        expect(fs.statSync(files.index).ino).not.toBe(inodes.index);
        expect(fs.statSync(files.session).ino).toBe(inodes.session);
        expect(fs.statSync(files.thread).ino).toBe(inodes.thread);
    });

    it('removes the shards a strict save stopped naming, and keeps the journal it never owned', async () => {
        const root = tempRoot('erase-strict');
        const client = await openClient(root);
        const savedAt = 1_700_000_002_100;
        const dropped = pathsOf(root, 'session-2');
        const kept = pathsOf(root, 'session-1');

        await client.saveCheckpoint(documentOf({ id: 'session-1', threads: ['thread-1'] }, { id: 'session-2', threads: ['thread-2'] }), { savedAt });

        await client.journalAppend('session-2', { turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: 'kept' } });
        await client.journalFlush('session-2');

        expect(fs.existsSync(dropped.record)).toBe(true);
        expect(fs.existsSync(dropped.threads)).toBe(true);
        expect(fs.existsSync(dropped.events)).toBe(true);

        await client.saveCheckpoint(documentOf({ id: 'session-1', threads: ['thread-1'] }), { savedAt });

        // The removal is a frame, so it is observable rather than implied: one `shard.erase`, and the
        // commit's own receipts still contain only shard saves.
        expect(client.stats().postedByKind['shard.erase']).toBe(1);
        expect(client.lastError()).toBeUndefined();

        // Unawaited on purpose: the strict save answered as soon as the SHARDS were durable, exactly
        // as inline `save()` answers before its best-effort collector runs. Draining the queue is what
        // makes the removal observable — and it lands behind every write, which is the next test.
        await client.barrier();

        expect(fs.existsSync(dropped.record)).toBe(false);
        expect(fs.existsSync(dropped.threads)).toBe(false);
        // v1's outcome, unchanged: the row is erased and the journal is kept, and the session
        // DIRECTORY is the store's to delete (./sessions.ts `remove()`).
        expect(fs.existsSync(dropped.events)).toBe(true);
        expect(fs.existsSync(dropped.directory)).toBe(true);
        // The session the header still names is untouched.
        expect(fs.existsSync(kept.record)).toBe(true);
        expect(fs.existsSync(kept.thread)).toBe(true);
        expect(JSON.parse(fs.readFileSync(path.join(root, 'harness', HARNESS_INDEX_FILE), 'utf8')).sessions).toEqual([{ id: 'session-1', ordinal: 1 }]);
    });

    it('removes only the transcript a commit stopped naming, keeping the live conversation', async () => {
        // The 256-record cap (./sessions.ts `capThreadRecords`) retires CONVERSATIONS under a session
        // that survives. The frame therefore names FILES, never the `threads/` directory — erasing the
        // directory here would delete every other conversation of a live session.
        const root = tempRoot('erase-thread');
        const client = await openClient(root);
        const savedAt = 1_700_000_002_200;
        const retired = pathsOf(root, 'session-1', 'thread-2');
        const kept = pathsOf(root, 'session-1', 'thread-1');

        await client.saveCheckpoint(documentOf({ id: 'session-1', threads: ['thread-1', 'thread-2'] }), { savedAt });

        expect(fs.existsSync(retired.thread)).toBe(true);

        await client.saveCheckpoint(documentOf({ id: 'session-1', threads: ['thread-1'] }), { savedAt });
        await client.barrier();

        expect(fs.existsSync(retired.thread)).toBe(false);
        expect(fs.existsSync(kept.thread)).toBe(true);
        expect(fs.existsSync(retired.record)).toBe(true);
        expect(client.stats().postedByKind['shard.erase']).toBe(1);
    });

    it('orders a queued removal BEHIND the queued writes it follows, so an orphan cannot come back', async () => {
        // The race the FIFO ordering is the whole answer to. Both documents land in the deferred slot
        // in one synchronous burst, and the slot still holds session-2's shards from the FIRST save:
        // posting the removal first would write session-2 back AFTER it was removed, leaving a
        // `session.json` no header names — a file `load()` ignores but every reader and every
        // operator sees.
        const root = tempRoot('erase-queued-order');
        const client = await openClient(root);
        const savedAt = 1_700_000_002_300;
        const dropped = pathsOf(root, 'session-2');

        client.queueCheckpointSave(documentOf({ id: 'session-1', threads: ['thread-1'] }, { id: 'session-2', threads: ['thread-2'] }), { savedAt });
        client.queueCheckpointSave(documentOf({ id: 'session-1', threads: ['thread-1'] }), { savedAt });

        await client.barrier();

        expect(client.stats().postedByKind['shard.erase']).toBe(1);
        expect(fs.existsSync(dropped.record)).toBe(false);
        expect(fs.existsSync(dropped.threads)).toBe(false);
        // And the writes the slot still held did run — they ran FIRST, which is the point.
        expect(fs.existsSync(pathsOf(root, 'session-1').record)).toBe(true);
    });

    it('cancels a queued removal when a later document in the same burst re-names the session', async () => {
        // A drop followed by a re-add inside one microtask is a document that never went away. The
        // pending removal is dropped (the plan above re-derives anything still owed), so no frame
        // lands after the write — and `shard.erase` is never posted at all.
        const root = tempRoot('erase-cancelled');
        const client = await openClient(root);
        const savedAt = 1_700_000_002_400;
        const kept = pathsOf(root, 'session-2', 'thread-2');

        client.queueCheckpointSave(documentOf({ id: 'session-1', threads: ['thread-1'] }, { id: 'session-2', threads: ['thread-2'] }), { savedAt });
        client.queueCheckpointSave(documentOf({ id: 'session-1', threads: ['thread-1'] }), { savedAt });
        client.queueCheckpointSave(documentOf({ id: 'session-1', threads: ['thread-1'] }, { id: 'session-2', threads: ['thread-2'] }), { savedAt });

        await client.barrier();

        expect(client.stats().postedByKind['shard.erase']).toBeUndefined();
        expect(fs.existsSync(kept.record)).toBe(true);
        expect(fs.existsSync(kept.thread)).toBe(true);
    });

    it('removes the shards a boot-time drop orphaned, once the loader says what was on disk', async () => {
        // A client that has never committed anything knows the footprint only from the loader
        // (`persistence.shardFootprint`). Without that priming a session the restorer dropped during
        // startup would keep its shards forever: the next document simply does not mention it, and
        // nothing else ever names the file for removal.
        const root = tempRoot('erase-primed');
        const directory = path.join(root, 'harness');
        const savedAt = 1_700_000_002_500;
        const dropped = pathsOf(root, 'session-2');
        const kept = pathsOf(root, 'session-1');

        // The bytes a previous process left behind.
        const seeding = await openClient(root);

        await seeding.saveCheckpoint(documentOf({ id: 'session-1', threads: ['thread-1'] }, { id: 'session-2', threads: ['thread-2'] }), { savedAt });

        // The loader's view of those bytes is what a boot starts from — and it is the SAME shape
        // `HarnessPersistence` hands its own inline garbage collector, which is why the client asks
        // for it structurally instead of re-deriving the layout a second time.
        const persistence = new HarnessPersistence(root);

        persistence.load();

        const boot = await createHarnessIoClient({
            persistence: { ...target(root), shardFootprint: persistence.shardFootprint },
            entry
        });

        clients.push(boot);

        await boot.saveCheckpoint(documentOf({ id: 'session-1', threads: ['thread-1'] }), { savedAt });
        await boot.barrier();

        expect(boot.stats().postedByKind['shard.erase']).toBe(1);
        expect(fs.existsSync(dropped.record)).toBe(false);
        expect(fs.existsSync(dropped.threads)).toBe(false);
        expect(fs.existsSync(kept.record)).toBe(true);
    });
});

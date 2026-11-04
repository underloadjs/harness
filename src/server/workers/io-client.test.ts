// Worker IO end to end, over a REAL worker thread (R1/R2/R4 acceptance).
//
// Every test here drives the coordinator-side client against an ACTUAL spawned worker:
// the entry is built with the same vite library-build shape the build owner adds to the
// package (see the `beforeAll` below), so the suite also proves the entry bundles
// standalone, loads in a thread, and answers the handshake - which is precisely the
// integration the build wiring depends on.
//
// What is asserted, and why it is the acceptance list:
//   - ordered save/journal/barrier: the queue, not the caller, guarantees a journal line
//     precedes the checkpoint that references it,
//   - error propagation: a refused write rejects with the message the inline writer
//     throws (no false success), and a queued write reports through the inline error
//     channels (no silent loss),
//   - close: outstanding work is fenced, later work is refused rather than dropped,
//   - round-trip load: the bytes the worker wrote are read back by the store's own
//     `HarnessPersistence.load()` / `HarnessJournal.read()`, with no worker involved.
//
// Durability claims are checked as STATED, never relaxed: an append answers 'written',
// a flush and a checkpoint answer 'durable' (./io-protocol.ts).

import fs from 'node:fs';
import path from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HarnessJournal } from '../journal';
import { HarnessPersistence, serializeHarnessDatabase } from '../persistence';
import type { HarnessDatabase } from '../persistence';
import {
    HarnessIoError,
    IO_WORKER_DIST_FILE,
    createHarnessIoClient,
    ioWorkerEntryCandidates,
    openHarnessIoClient,
    resolveIoWorkerEntry
} from './io-client';
import type { HarnessIoClient, HarnessIoClientOptions } from './io-client';

// One directory deeper than ../journal.test.ts (src/server/workers), so the package
// root is three levels up. Scratch still belongs in the REPO-root Temp/.
const PACKAGE_ROOT = path.resolve(__dirname, '../../..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const roots: string[] = [];
const clients: HarnessIoClient[] = [];
let buildDir = '';

// The absolute path of the built worker entry, filled in by `beforeAll`.
let entry = '';

const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-io-client-${label}-`));

    roots.push(root);

    return root;
};

const target = (root: string): { directory: string; file: string } => {
    const directory = path.join(root, 'harness');

    return { directory, file: path.join(directory, 'state.json') };
};

// The store's own reader is the judge of these records: `definition`/`preset` carry
// every field `readDescriptor`/`readPresetRecord` requires, and `usage.total` is
// mandatory. A document that fails that check would not prove the restart path works.
const PRESET = {
    name: 'live',
    title: 'Live',
    description: 'd',
    requiresEndpoint: false,
    primary: 'a',
    subagents: [],
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
    primary: 'a',
    subagents: [],
    agents: ['a'],
    tools: [],
    builtin: true,
    editable: true
};

const document = (marker: string, events = 0): HarnessDatabase => ({
    version: 1,
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
            core: { version: 1, agents: {}, memory: {} } as never
        }
    ]
});

const openClient = async (root: string, options: Partial<HarnessIoClientOptions> = {}): Promise<HarnessIoClient> => {
    const client = await createHarnessIoClient({ persistence: target(root), entry, ...options });

    clients.push(client);

    return client;
};

beforeAll(async () => {
    // Builds `src/server/workers/io-worker.ts` as an ESM library entry, exactly as the
    // package build will (vite library entry name "io-worker" -> dist/<name>.mjs, node
    // builtins external). If this fails, the worker mode cannot ship, and the message is
    // a bundling failure rather than a test artefact.
    buildDir = fs.mkdtempSync(path.join(TEMP_ROOT, 'harness-io-build-'));

    await build({
        configFile: false,
        root: PACKAGE_ROOT,
        logLevel: 'silent',
        build: {
            outDir: buildDir,
            emptyOutDir: true,
            minify: false,
            sourcemap: false,
            lib: {
                entry: { 'io-worker': path.resolve(__dirname, 'io-worker.ts') },
                formats: ['es']
            },
            rollupOptions: {
                external: [/^node:/],
                output: {
                    entryFileNames: IO_WORKER_DIST_FILE,
                    // The loop is a sibling CHUNK of the entry (the entry calls into it -
                    // see ./io-worker.ts). `.mjs` keeps Node's module typing explicit
                    // without relying on a nearby `"type": "module"`, which is what the
                    // package's own dist does.
                    chunkFileNames: 'io-worker-chunks/[name]-[hash].mjs'
                }
            }
        }
    });

    entry = path.join(buildDir, IO_WORKER_DIST_FILE);

    expect(fs.existsSync(entry)).toBe(true);
}, 120_000);

afterAll(async () => {
    for (const client of clients) {
        await client.close().catch(() => undefined);
    }

    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });

    fs.rmSync(buildDir, { recursive: true, force: true });
});

describe('startup', () => {
    it('spawns the built entry and speaks the protocol before doing any work', async () => {
        const client = await openClient(tempRoot('start'));

        expect(client.entry).toBe(entry);
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
            refused: 0,
            late: 0,
            writtenBytes: 0,
            lastCheckpointBytes: 0,
            lastCheckpointDurationMs: 0,
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
            expect((error as HarnessIoError).message).toContain(IO_WORKER_DIST_FILE);
        }

        expect(resolveIoWorkerEntry({ entry }).path).toBe(entry);
        // An override is reported as `explicit`, and only a `.ts` path flips the spawn into
        // source mode (the execArgv the entry's resolver hooks need).
        expect(resolveIoWorkerEntry({ entry }).mode).toBe('explicit');
        expect(resolveIoWorkerEntry({ entry: path.resolve(__dirname, 'io-worker.ts') }).mode).toBe('source');
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

        // Nothing has reached the port yet: both operations are registered, not written.
        expect(client.pending()).toEqual({ operations: 2, gated: 2, lastFrameBytes: 0, coalescedCheckpoint: false });
        expect(client.stats().posted).toBe(0);

        await client.ready();

        expect((await save).outcome).toBe('durable');
        await client.barrier();

        expect(client.stats().posted).toBe(2);
        expect(client.pending()).toEqual({ operations: 0, gated: 0, lastFrameBytes: expect.any(Number), coalescedCheckpoint: false });
        expect(new HarnessPersistence(root).load()?.sessions[0]?.turns[0]?.id).toBe('turn-early');
        expect(new HarnessJournal(path.join(root, 'harness'), 'sess-early').read().events).toHaveLength(1);
    });

    it('runs a SOURCE-mode worker, so dev and test need no build', async () => {
        // The same acceptance path as the bundle, loaded as `src/**.ts`: the entry installs
        // resolve hooks and the client adds `--experimental-transform-types` (the shape
        // ./lane-host.ts already uses). If this breaks, worker IO cannot run under
        // `vite-node`, and the built-entry fallback is the only thing keeping dev alive.
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

    it('lists the resolution chain the build has to satisfy', () => {
        const candidates = ioWorkerEntryCandidates();

        expect(candidates[0]).toEqual({ path: '@underload/harness/io-worker', mode: 'package' });
        // The built entry next to this module, the package dist copy, and the two source
        // spellings - in that priority order, because production must run a bundle even in
        // a checkout that has both.
        expect(candidates.map((candidate) => candidate.mode)).toEqual(['package', 'built', 'built', 'source', 'source']);
        expect(candidates[2].path).toBe(path.join(PACKAGE_ROOT, 'dist', IO_WORKER_DIST_FILE));
        expect(candidates[3].path).toBe(path.resolve(__dirname, 'io-worker.ts'));
        expect(candidates.length).toBe(5);
    });

    it('resolves the entry the way a checkout is laid out right now', async () => {
        // With no override at all, either the built entry exists (and the client starts
        // from it) or the failure names every candidate. Both are assertions; guessing
        // one would make the suite depend on another owner's build state.
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

        if (resolved !== undefined) expect(ioWorkerEntryCandidates().some((candidate) => candidate.path === resolved)).toBe(true);
    });
});

describe('durable checkpoint', () => {
    it('writes bytes the inline reader loads back unchanged', async () => {
        const root = tempRoot('roundtrip');
        const client = await openClient(root);
        const savedAt = 1_700_000_000_002;
        const doc = document('worker');

        const receipt = await client.saveCheckpoint(doc, { savedAt });

        expect(receipt).toEqual({
            callId: 1,
            kind: 'checkpoint.save',
            outcome: 'durable',
            durationMs: expect.any(Number),
            bytes: serializeHarnessDatabase(doc, savedAt).length
        });

        // Restart semantics: a FRESH persistence instance over the same root, no worker.
        const loaded = new HarnessPersistence(root).load();

        expect(loaded?.savedAt).toBe(savedAt);
        expect(loaded?.sessions[0]?.turns[0]?.id).toBe('turn-worker');

        // The atomic replacement left nothing behind, and the file is byte-identical to
        // what the inline writer produces for the same document.
        expect(fs.readdirSync(target(root).directory)).toEqual(['state.json']);
        expect(fs.readFileSync(target(root).file, 'utf8')).toBe(serializeHarnessDatabase(doc, savedAt));

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
                file: path.join(workerRoot, 'occupied', 'harness', 'state.json')
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
        expect(stats.failed).toBe(1);
        expect(stats.outstanding).toBe(0);
    });

    it('never reports success for a document the worker refused for size', async () => {
        const root = tempRoot('frame-bound');
        const client = await openClient(root, { maxFrameBytes: 256 });

        await expect(client.saveCheckpoint(document('huge', 200))).rejects.toThrow(/above the 256 byte IO frame limit/);

        // Nothing was written, and the estimate now blocks further clones of a database
        // that is permanently too large.
        expect(new HarnessPersistence(root).load()).toBeUndefined();
        expect(client.stats().refused).toBe(0);
        expect(client.stats().failed).toBe(1);

        await expect(client.saveCheckpoint(document('huge', 200))).rejects.toThrow(/measured .* above the 256 byte frame limit/);

        expect(client.stats().refused).toBe(1);
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

        const read = new HarnessJournal(path.join(root, 'harness'), sessionId).read();

        expect(read.problems).toEqual([]);
        expect(read.truncatedTail).toBe(false);
        expect(read.events.map((event) => [event.index, (event.event as { delta?: string }).delta])).toEqual([
            [0, 'a'],
            [1, 'b'],
            [2, 'c'],
            [3, 'd']
        ]);

        // Four appends, then the commit's flush and checkpoint. The handshake and the
        // close frames are controls, not operations, and are not counted (./io-client.ts).
        expect(client.stats().posted).toBe(6);
        expect(client.stats().completed).toBe(6);
        expect(client.stats().failed).toBe(0);
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

        // 8000 recorded events is a document the worker needs several milliseconds to
        // serialize, write and fsync, so a 1ms watchdog cannot race its way to a success.
        await expect(client.saveCheckpoint(document('slow', 8_000))).rejects.toThrow(/did not answer checkpoint.save \(call 1\) within 1ms/);

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
    });
});

describe('coalescing and barriers', () => {
    it('collapses a synchronous burst of best-effort checkpoints into one commit', async () => {
        const root = tempRoot('coalesce');
        const client = await openClient(root);

        // Five observer fires in one synchronous turn (a burst of `noteStateChange`):
        // only the newest document is worth serializing, and the client must say so.
        for (const marker of ['one', 'two', 'three', 'four', 'five']) client.queueCheckpointSave(document(marker));

        expect(client.pending()).toEqual({ operations: 0, gated: 0, lastFrameBytes: 0, coalescedCheckpoint: true });

        await client.barrier();

        expect(client.stats().superseded).toBe(4);
        // Five queued saves, ONE frame: the coalescing is visible in the counter that
        // says what was dropped, and in the fact that only one commit was posted.
        expect(client.stats().posted).toBe(1);

        const loaded = new HarnessPersistence(root).load();

        expect(loaded?.sessions[0]?.turns[0]?.id).toBe('turn-five');
        expect(client.pending().coalescedCheckpoint).toBe(false);
    });

    it('lets a strict save supersede the pending document but fences queued appends', async () => {
        const root = tempRoot('strict-supersede');
        const client = await openClient(root);
        const sessionId = 'sess-strict';

        client.queueJournalAppend(sessionId, { turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: 'first' } });
        client.queueCheckpointSave(document('stale'));

        const receipt = await client.saveCheckpoint(document('current'), { savedAt: 1_700_000_000_003 });

        expect(receipt.outcome).toBe('durable');
        expect(client.stats().superseded).toBe(1);
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

        expect(stats.writtenBytes).toBe(serializeHarnessDatabase(doc, savedAt).length);
        expect(stats.lastCheckpointBytes).toBe(serializeHarnessDatabase(doc, savedAt).length);
        expect(stats.lastCheckpointDurationMs).toBeTypeOf('number');
        expect(client.pending().lastFrameBytes).toBe(stats.lastCheckpointBytes);

        const onCheckpointError = vi.fn();
        const second = await openClient(root, { onCheckpointError });

        await second.saveCheckpoint(document('healthy'));

        // A success clears the sticky error, as `lastWriteError` does inline.
        expect(second.lastError()).toBeUndefined();
        expect(onCheckpointError).not.toHaveBeenCalled();
    });
});

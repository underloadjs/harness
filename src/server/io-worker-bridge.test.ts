// D4 (R1/R2/R4): the session store wired to the IO WORKER - the integration the acceptance
// list is written against.
//
// ./workers/io-client.test.ts already proves the CLIENT is correct in isolation (ordering,
// barriers, error close, byte identity with the inline writer). This file proves the other
// half: that `SessionStore`, `startHarnessServer` and the built worker entry work TOGETHER, so
// a deployment that sets `ioExecution: 'worker'` really does move its durability off the
// coordinator.
//
// What each test pins down, in the order the acceptance list states it:
//   1. startup readiness - `ioReady()` settles before the store is usable, and a missing entry
//      fails startup (no inline fallback, ever),
//   2. writes after serving are off the coordinator: a STRICT save is durable on disk before
//      the promise resolves, and the op counters show the worker performed it,
//   3. strict errors surface with the inline message and roll back (no false success),
//   4. journal events stay ordered and reload through the coordinator's own inline reader,
//   5. reset/delete/dispose are queued operations, ordered against the saves that follow them,
//   6. shutdown drains the graceful document and reports what did not make it,
//   7. a worker-written database restarts identically in a store with NO worker,
//   8. the REAL built entry (`vite` library build, same shape as the package's dist) round-trips
//      save / journal / reload against the store's own readers.
//
// Every assertion is an exact value (op counts, file listings, byte lengths, message text), not
// a range, so a regression in either mode shows up as a wrong number rather than a shrug.
//
// Cross-references:
//   - ./sessions.ts                        - the store's worker branches (`io`, `persistOrThrow`,
//                                            `queueJournal*`, `ioReady`, `drainIo`)
//   - ./workers/io-client.ts               - the FIFO queue and the integration contract
//   - ./workers/io-client.test.ts          - the client-level proof (same built-entry recipe)
//   - ./start.ts                           - readiness before `listen`, drain before close
//   - ../../../vite.config.ts              - the `io-worker` entry this suite mirrors

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessPreset, HarnessProgress, HarnessStream, HarnessStreamEvent, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { HARNESS_JOURNAL_DIRECTORY, HarnessJournal } from './journal';
import { HARNESS_DATABASE_DIRECTORY, HARNESS_DATABASE_FILE, HarnessPersistence } from './persistence';
import type { HarnessDatabase } from './persistence';
import { SessionStore } from './sessions';
import { startHarnessServer } from './start';
// The service adapter is the OTHER host entry point (the @underload/service gateway owns the
// listener there), so readiness has to be proven for it as well - it has no startup hook at
// all: the runtime is created inside the first request.
import { createHarnessServiceHandler } from './service';
import type { ServiceEndpointContext } from './service';
import { getHarnessRuntime } from './runtime';
import { DEFAULT_RUNTIME_CONFIGURATION } from './config';
import type { ServerRuntimeConfiguration } from './config';
import {
    HarnessIoError,
    IO_WORKER_DIST_FILE,
    createHarnessIoClient,
    openHarnessIoClient
} from './workers';
import type { HarnessIoClient } from './workers';

// Scratch belongs in the REPO-root Temp/ (../AGENTS.md), one directory per suite.
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const roots: string[] = [];
const stores: SessionStore[] = [];
const clients: HarnessIoClient[] = [];
let buildDir = '';

// The built worker entry, produced once by `beforeAll`. Every store below is constructed with
// `ioEntry: entry`, so the suite exercises the SHIPPED bundle rather than the source entry (the
// source-mode path is already covered by ./workers/io-client.test.ts).
let entry = '';

const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-io-bridge-${label}-`));

    roots.push(root);

    return root;
};

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'server-secret-key',
    model: 'scripted/test'
};

// A one-agent scripted harness: `stream` yields a fixed pair of frames, so the journal's event
// sequence and the checkpoint's turn record are both known exactly in advance.
const answerStream = (text: string): HarnessStream =>
    async function* (): AsyncGenerator<HarnessStreamEvent> {
        yield { type: 'text', delta: text };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };

const scriptedPreset = (name = 'one', text = 'hello'): HarnessPreset => ({
    name,
    title: name,
    description: `${name} scripted preset`,
    requiresEndpoint: false,
    primary: name,
    subagents: [],
    agents: [name],
    tools: [],
    builtin: true,
    editable: true,
    create: (settings, progress: HarnessProgress, report) =>
        harness({
            agents: {
                [name]: agent({
                    model: settings.model,
                    instruction: `You are the ${name} scripted agent.`,
                    stream: answerStream(text)
                })
            },
            primary: name,
            presets: false,
            report: {
                progress,
                ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
            }
        })
});

// A run that holds after one delta: the terminal transition (`cancel`) then lands while the turn
// is genuinely RUNNING, which is the case the journal fence exists for.
const gatedPreset = (name = 'gated'): { preset: HarnessPreset; started: Promise<void>; release: () => void } => {
    let startRun!: () => void;

    const started = new Promise<void>((resolve) => {
        startRun = resolve;
    });

    let release!: () => void;

    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });

    const preset: HarnessPreset = {
        name,
        title: name,
        description: `${name} gated preset`,
        requiresEndpoint: false,
        primary: name,
        subagents: [],
        agents: [name],
        tools: [],
        builtin: true,
        editable: true,
        create: (settings, progress: HarnessProgress, report) =>
            harness({
                agents: {
                    [name]: agent({
                        model: settings.model,
                        instruction: `You are the ${name} gated agent.`,
                        stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
                            yield { type: 'text', delta: 'held' };
                            startRun();
                            await gate;
                            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                        }
                    })
                },
                primary: name,
                presets: false,
                report: {
                    progress,
                    ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
                }
            })
    };

    return { preset, started, release };
};

// The RESOLVED runtime shape a `HARNESS_IO_EXECUTION=worker` deployment produces, minus the
// env read: every field comes from the shipped default, and only the durability mode and the
// entry are pinned. `threadExecution` stays 'inline' on purpose - this suite is about
// durability, and mixing lane workers in would blur which thread performed which write.
const workerRuntime = (): ServerRuntimeConfiguration => ({
    ...DEFAULT_RUNTIME_CONFIGURATION,
    ioExecution: 'worker',
    ioEntry: entry
});

type Bridge = {
    store: SessionStore;
    persistence: HarnessPersistence;
    registry: ReturnType<typeof createHarnessRegistry>;
    // The client this store opened (undefined only for an inline store).
    io: HarnessIoClient;
};

const workerStore = (
    root: string,
    options: { io?: HarnessIoClient; database?: HarnessDatabase; presets?: HarnessPreset[] } = {}
): Bridge => {
    const persistence = new HarnessPersistence(root);
    const registry = createHarnessRegistry(options.presets ?? [scriptedPreset()]);

    const store = new SessionStore(SETTINGS, registry, undefined, {
        persistence,
        ...(options.io === undefined ? { runtime: workerRuntime() } : { io: options.io }),
        ...(options.database === undefined ? {} : { database: options.database })
    });

    stores.push(store);

    const io = store.ioWorker;

    if (io === undefined) throw new Error('A worker-mode store must open an IO client.');

    return { store, persistence, registry, io };
};

// Inline counterpart: same root, same file, NO worker. Used to prove the two modes are
// interchangeable readers/writers of one format.
const inlineStore = (root: string, database?: ReturnType<HarnessPersistence['load']>): SessionStore => {
    const persistence = new HarnessPersistence(root);
    const store = new SessionStore(SETTINGS, createHarnessRegistry([scriptedPreset()]), undefined, {
        persistence,
        ...(database === undefined ? {} : { database })
    });

    stores.push(store);

    return store;
};

beforeAll(async () => {
    // The SAME library-build shape ../../../vite.config.ts now emits for the package (`entry`
    // keyed `io-worker`, ESM, node builtins external, the loop as a sibling chunk). A bundling
    // regression fails here with a bundler message, not a mysteriously silent worker.
    buildDir = fs.mkdtempSync(path.join(TEMP_ROOT, 'harness-io-bridge-build-'));

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
                entry: { 'io-worker': path.resolve(__dirname, 'workers', 'io-worker.ts') },
                formats: ['es']
            },
            rollupOptions: {
                external: [/^node:/],
                output: {
                    entryFileNames: IO_WORKER_DIST_FILE,
                    chunkFileNames: 'io-worker-chunks/[name]-[hash].mjs'
                }
            }
        }
    });

    entry = path.join(buildDir, IO_WORKER_DIST_FILE);

    expect(fs.existsSync(entry)).toBe(true);
}, 180_000);

afterEach(async () => {
    // Every store owns a thread. `dispose()` queues the graceful document and FIRES the drain;
    // awaiting `drainIo()` (the same cached promise) is what releases the thread before the next
    // test starts, so a leaked worker can never make a later op count ambiguous.
    for (const store of stores.splice(0)) {
        store.dispose();

        await store.drainIo('test teardown');
    }

    for (const client of clients.splice(0)) await client.close().catch(() => undefined);
});

afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });

    fs.rmSync(buildDir, { recursive: true, force: true });
});

describe('startup and readiness', () => {
    it('opens one client per root and answers readiness before any write is claimed', async () => {
        const root = tempRoot('ready');
        const { store, io } = workerStore(root);

        expect(store.workerIoExecution).toBe(true);

        // `ioReady()` is the handshake gate: operations issued during construction are held and
        // released in call order, so nothing may be reported as written before it settles.
        await store.ioReady();

        expect(io.isOpen()).toBe(true);
        // `hello` is a control frame, not an operation: readiness alone has posted nothing.
        expect(io.pending()).toEqual({ operations: 0, gated: 0, lastFrameBytes: 0, coalescedCheckpoint: false });

        const summary = await store.drainIo('ready check');

        expect(summary).toEqual({ drained: 0, failures: [] });
        expect(io.isOpen()).toBe(false);
    });

    it('refuses to start on a missing entry, and never falls back to inline', async () => {
        const root = tempRoot('missing-entry');
        const persistence = new HarnessPersistence(root);

        expect(() =>
            openHarnessIoClient({
                persistence,
                entry: path.join(root, 'nope.mjs')
            })
        ).toThrow(/does not exist/);

        // The store surface fails the same way, because the constructor is where the client is
        // opened: a deployment with no entry does not silently become an inline server.
        let thrown: unknown;

        try {
            new SessionStore(SETTINGS, createHarnessRegistry([scriptedPreset()]), undefined, {
                persistence,
                runtime: { ...DEFAULT_RUNTIME_CONFIGURATION, ioExecution: 'worker', ioEntry: path.join(root, 'nope.mjs') }
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(HarnessIoError);
        expect((thrown as HarnessIoError).code).toBe('worker-entry-missing');
        expect(fs.existsSync(persistence.file)).toBe(false);
    });

    it('a standalone listener with worker IO binds its port only after readiness, and persists over HTTP', async () => {
        const root = tempRoot('server');

        const started = await startHarnessServer({
            port: 0,
            staticRoot: null,
            databaseRoot: root,
            // `ioExecution` is a resolved-runtime field, so the standalone entry point honours it
            // exactly like `HARNESS_IO_EXECUTION=worker` would.
            runtime: { ioExecution: 'worker', ioEntry: entry }
        });

        expect(started.runtime.ioExecution).toBe('worker');
        expect(started.store.workerIoExecution).toBe(true);

        const response = await fetch(`${started.url}/api/sessions`, {
            method: 'POST',
            // The standalone dispatcher answers a browser-shaped write only when the client
            // identifies itself (see ./api.ts and the `X-Harness-Client` usage in server.test.ts).
            headers: { 'content-type': 'application/json', 'X-Harness-Client': 'ui' },
            body: JSON.stringify({ harness: 'instruct' })
        });

        expect(response.status).toBe(201);
        const created = (await response.json()) as { session: { id: string } };

        // The POST has returned, so the checkpoint the response acknowledges is ALREADY on disk:
        // strict saves are awaited by the dispatcher, not merely queued.
        const reloaded = new HarnessPersistence(root).load();

        expect(reloaded?.sessions.map((session) => session.id)).toEqual([created.session.id]);

        // Off-loop, and measurable as off-loop: the coordinator posted exactly one operation and
        // the worker reported it complete.
        const stats = started.store.ioWorker?.stats();

        expect(stats?.posted).toBe(1);
        expect(stats?.completed).toBe(1);
        expect(stats?.failed).toBe(0);

        await started.close();

        expect(started.store.ioWorker?.isOpen()).toBe(false);
    });

    it('a standalone listener with worker IO fails startup when the entry is missing', async () => {
        const root = tempRoot('server-missing');

        await expect(
            startHarnessServer({
                port: 0,
                staticRoot: null,
                databaseRoot: root,
                runtime: { ioExecution: 'worker', ioEntry: path.join(root, 'absent.mjs') }
            })
        ).rejects.toThrow(/worker entry does not exist/);
    });
});

describe('service host (the gateway has no startup hook)', () => {
    // The service adapter creates the runtime INSIDE the first request, so worker-mode
    // readiness is awaited there per request (`./service.ts`), and a runtime that cannot open
    // its IO client must answer 500 with the reason instead of serving an inline store.
    const context = (path: string): ServiceEndpointContext => ({
        req: { path, header: () => undefined, raw: { method: 'POST' } }
    });

    it('awaits IO readiness before the first service response, and persists durably', async () => {
        const root = tempRoot('service');

        const handler = createHarnessServiceHandler({
            root,
            execution: { ioExecution: 'worker', ioEntry: entry }
        });

        const created = await handler(context('/v1/harness/sessions'), { body: { harness: 'instruct' } });

        expect(created.status).toBe(201);

        const session = (created.response as { session: { id: string } }).session;

        // The response left, therefore the checkpoint the response acknowledges is on disk -
        // written by the worker, and read back here by the inline reader.
        expect(new HarnessPersistence(root).load()?.sessions.map((stored) => stored.id)).toEqual([session.id]);

        // The runtime this handler created is a root-keyed singleton; register its store so the
        // shared teardown disposes it and drains (and releases) its worker thread.
        stores.push(getHarnessRuntime({ root }).store);
    });

    it('answers 500 naming the entry when a worker-mode service runtime cannot start', async () => {
        const root = tempRoot('service-missing');

        const handler = createHarnessServiceHandler({
            root,
            execution: { ioExecution: 'worker', ioEntry: path.join(root, 'absent.mjs') }
        });

        const response = await handler(context('/v1/harness/sessions'), { body: { harness: 'instruct' } });

        expect(response.status).toBe(500);
        expect((response.response as { error: { message: string } }).error.message).toMatch(/IO worker entry|does not exist/);
        // Nothing was written, because nothing started: the failure is startup, not a degraded
        // inline store.
        expect(fs.existsSync(path.join(root, HARNESS_DATABASE_DIRECTORY, HARNESS_DATABASE_FILE))).toBe(false);
    });
});

describe('strict writes are off the coordinator', () => {
    it('awaits the worker receipt, and the document the response acknowledges is on disk', async () => {
        const root = tempRoot('strict-create');
        const { store, persistence, io } = workerStore(root);

        const created = await store.create('one');

        // No extra await: `create` resolved, therefore the rename happened.
        const reloaded = new HarnessPersistence(root).load();

        expect(reloaded?.sessions.map((session) => session.id)).toEqual([created.id]);

        const stats = io.stats();

        expect(stats).toMatchObject({ posted: 1, completed: 1, failed: 0, refused: 0, faults: 0, superseded: 0, outstanding: 0 });
        // The size the worker measured is the size of the file, byte for byte: the client's
        // O(1) frame guard is fed by a real measurement taken off-thread, not by a second
        // stringify on the coordinator.
        expect(stats.lastCheckpointBytes).toBe(fs.statSync(persistence.file).size);
        // No staging debris: the worker's staging name carries its own owner, and the rename
        // consumed it.
        expect(fs.readdirSync(path.join(root, HARNESS_DATABASE_DIRECTORY))).toEqual([HARNESS_DATABASE_FILE]);
    });

    it('a failed durable commit rejects with the inline message and rolls the mutation back', async () => {
        const root = tempRoot('strict-fail');
        const persistence = new HarnessPersistence(root);

        // A 1-byte frame limit is the cheapest deterministic write failure available: the worker
        // measures the true payload and refuses, and the client learns the size from that reply.
        const io = await createHarnessIoClient({ persistence, entry, maxFrameBytes: 1 });

        clients.push(io);

        const store = new SessionStore(SETTINGS, createHarnessRegistry([scriptedPreset()]), undefined, { persistence, io });

        stores.push(store);

        const failure = await store.create('one').then(
            () => undefined,
            (error: unknown) => error as Error
        );

        expect(failure).toBeInstanceOf(Error);
        // The 500 body carries the same sentence in both modes (./io-protocol.ts keeps the raw
        // writer text verbatim).
        expect(failure?.message).toContain('Could not save the harness database: ');
        expect(failure?.message).toMatch(/IO frame limit/);
        // Rollback: the session never existed, and the file was never written.
        expect(store.size).toBe(0);
        expect(fs.existsSync(persistence.file)).toBe(false);
        // The sticky error channel (worker-mode twin of `persistence.lastWriteError`) holds the
        // raw reason, without the store's 500 wrapper.
        expect(store.persistenceError).toMatch(/above the 1 byte IO frame limit/);
        expect(io.stats()).toMatchObject({ posted: 1, completed: 0, failed: 1, refused: 0 });

        // Second attempt: the client now KNOWS the size, so it refuses locally - counted, reported,
        // and never presented as a write.
        const second = await store.create('one').then(
            () => undefined,
            (error: unknown) => error as Error
        );

        expect(second?.message).toMatch(/measured \d+ bytes on its last measurement/);
        expect(store.size).toBe(0);
        // The SECOND failure is a local refusal, not a second worker round trip: `refused` counts
        // it and `failed` stays at the one operation the worker actually answered (posted is still
        // 1, because the refused frame never reached the port).
        expect(io.stats()).toMatchObject({ posted: 1, completed: 0, failed: 1, refused: 1 });
    });

    it('a terminal transition fences the journal tail it references, then commits', async () => {
        const root = tempRoot('terminal');
        const gate = gatedPreset();
        const { store, io, persistence } = workerStore(root, { presets: [gate.preset] });

        const created = await store.create('gated');

        // The run holds after one delta, so the cancel below lands while the turn is live: that
        // is the terminal transition of a session whose events were just journal-appended.
        const running = store.run(created.id, 'hold the turn', async () => {});

        await gate.started;

        // Settle everything queued first (the appends and any coalesced checkpoint), so the op
        // delta below measures ONLY the terminal commit.
        await io.barrier();

        const before = io.stats();
        const cancelled = await store.cancel(created.id, { all: true });
        const after = io.stats();

        expect(cancelled).toBe(true);

        // The terminal commit posted EXACTLY one journal fence: one fsync of the tail this
        // document references, and `cancel` resolved only after its receipt. The checkpoint count
        // is `>= 1` on purpose rather than exact: the abort continuation settles inside the same
        // window, and its own best-effort saves (the run's terminal write plus a state-change
        // observer) are queued behind it - legitimately, because the queue is FIFO, which is also
        // what puts the fence ahead of the rename. Ordering itself is proven per operation in
        // ./workers/io-client.test.ts; what is pinned here is that the store ASKED for the fence
        // exactly once, and that the document the response acknowledges is on disk.
        expect((after.postedByKind['journal.flush'] ?? 0) - (before.postedByKind['journal.flush'] ?? 0)).toBe(1);
        expect((after.postedByKind['checkpoint.save'] ?? 0) - (before.postedByKind['checkpoint.save'] ?? 0)).toBeGreaterThanOrEqual(1);
        expect(after.failed).toBe(before.failed);

        gate.release();
        await running;

        // The run's terminal save is the best-effort (queued) path, so the barrier is what makes
        // it observable before the file is read.
        await io.barrier();

        const reloaded = new HarnessPersistence(root).load();
        const turns = reloaded?.sessions[0]?.turns ?? [];

        expect(turns.map((turn) => turn.status)).toEqual(['cancelled']);

        const events = (turns[0]?.events ?? []) as unknown as { type: string }[];
        const read = new HarnessJournal(persistence.directory, created.id).read();

        // One story, two readers: the journal holds exactly the events the checkpoint lists, in
        // the same order, and every one of them was written by the worker.
        expect(read.events.map((record) => (record.event as { type: string }).type)).toEqual(events.map((event) => event.type));
        expect(io.stats().failed).toBe(0);
        expect(io.stats().faults).toBe(0);
        expect(io.stats().outstanding).toBe(0);
        expect(io.journalError(created.id)).toBeUndefined();
        expect(io.journalFailures(created.id)).toBe(0);
        expect(store.journalErrors).toEqual([]);
    });

    it('routes every durable write through the worker, never through the inline writer', async () => {
        // The deterministic form of "the writes left this thread": `HarnessPersistence.save` is
        // the ONLY inline commit primitive (two-space stringify + mkdir/open/write/fsync/rename),
        // so a worker-mode store that never calls it has moved every durable write - and the
        // worker's own per-kind receipts show the work was performed instead.
        const root = tempRoot('no-inline-save');
        const saves = vi.spyOn(HarnessPersistence.prototype, 'save');

        try {
            const { store, io, persistence } = workerStore(root);

            const created = await store.create('one');

            await store.run(created.id, 'remember this', async () => {});
            await store.reset(created.id);
            await io.barrier();

            expect(saves).not.toHaveBeenCalled();

            // The commits happened, on the other thread: at least one checkpoint operation (the
            // strict create, the strict reset, and any coalesced observer save - the exact count
            // depends on how many observer fires merged, which is the point of the coalescing).
            expect(io.stats().postedByKind['checkpoint.save'] ?? 0).toBeGreaterThan(0);
            expect(io.stats().failed).toBe(0);

            // And the bytes are real: the coordinator's own reader loads the worker's document
            // with no error recorded on either writer channel.
            const reloaded = new HarnessPersistence(root).load();

            expect(reloaded?.sessions).toHaveLength(1);
            expect(reloaded?.sessions[0]?.turns).toEqual([]);
            expect(persistence.lastWriteError).toBeUndefined();
        } finally {
            saves.mockRestore();
        }
    });
});

describe('journal ordering and the single writer', () => {
    it('appends in recorder order, and the coordinator reader sees exactly the documented events', async () => {
        const root = tempRoot('journal');
        const { store, persistence } = workerStore(root);

        const created = await store.create('one');

        await store.run(created.id, 'remember this', async () => {});
        await store.ioWorker?.barrier();

        const journal = new HarnessJournal(persistence.directory, created.id);
        const read = journal.read();

        expect(read.missing).toBe(false);
        expect(read.problems).toEqual([]);
        expect(read.truncatedTail).toBe(false);
        expect(read.events.map((record) => record.index)).toEqual([0, 1, 2]);
        expect(read.events.map((record) => (record.event as { type: string }).type)).toEqual(['start', 'text', 'done']);

        // The document lists the same events in the same order: the journal and the checkpoint are
        // one story, written by one thread, in call order - and every logged line belongs to the
        // turn the checkpoint names (no cross-session interleaving, which is what the per-session
        // queue ordering guarantees).
        const reloaded = new HarnessPersistence(root).load();
        const turn = reloaded?.sessions[0]?.turns[0];
        const events = (turn?.events ?? []) as unknown as { type: string }[];

        expect([...new Set(read.events.map((record) => record.turnId))]).toEqual([turn?.id]);
        expect(events.map((event) => event.type)).toEqual(['start', 'text', 'done']);
    });

    it('reset truncates and delete removes, each ordered ahead of the save that follows it', async () => {
        const root = tempRoot('journal-reset');
        const { store, persistence, io } = workerStore(root);

        const created = await store.create('one');

        await store.run(created.id, 'remember this', async () => {});

        await store.reset(created.id);
        await io.barrier();

        const afterReset = new HarnessJournal(persistence.directory, created.id).read();

        expect(afterReset.events).toEqual([]);
        expect(afterReset.empty).toBe(true);

        const reloaded = new HarnessPersistence(root).load();

        expect(reloaded?.sessions[0]?.turns).toEqual([]);

        expect(await store.remove(created.id)).toBe(true);
        await io.barrier();

        // A deleted session leaves no journal footprint a restart could replay as a ghost turn.
        expect(fs.existsSync(path.join(persistence.directory, HARNESS_JOURNAL_DIRECTORY, created.id))).toBe(false);
        expect(new HarnessPersistence(root).load()?.sessions).toEqual([]);
        expect(io.stats().failed).toBe(0);
    });
});

describe('shutdown durability', () => {
    it('drains the graceful document, reports nothing lost, and refuses every later write', async () => {
        const root = tempRoot('shutdown');
        const { store, io, persistence } = workerStore(root);

        const created = await store.create('one');

        await store.run(created.id, 'remember this', async () => {});

        store.dispose();

        const summary = await store.drainIo('test shutdown');

        // The dispose document was still in the coalescing slot when close() ran; close() flushed
        // it and drained it, so the process may now exit without losing the session.
        expect(summary?.failures).toEqual([]);
        expect(new HarnessPersistence(root).load()?.sessions.map((session) => session.id)).toEqual([created.id]);

        // Zero handles were still held: `disposeSession` queued a `journal.close` for this session
        // (fsync + release) BEFORE the client's `shutdown` frame, and the queue is FIFO - so by the
        // time `bye` is answered the worker's journal map is already empty. `drained` counts the
        // handles still open at shutdown, which is why the coalesced document above is the thing
        // this number really protects.
        expect(summary?.drained).toBe(0);
        expect(io.isOpen()).toBe(false);

        // A closed client cannot promise a write, and the store's own shutdown guard answers the
        // same 503 sentence in both modes.
        await expect(store.create('one')).rejects.toThrow('The harness database is closed; nothing was saved.');
    });
});

describe('restart across modes', () => {
    it('a worker-written database resumes in a plain inline store, byte for byte', async () => {
        const root = tempRoot('resume');
        const { store, persistence } = workerStore(root);

        const created = await store.create('one');

        await store.run(created.id, 'remember this', async () => {});

        store.dispose();
        await store.drainIo('handover');

        const database = new HarnessPersistence(root).load();

        expect(database?.sessions.map((session) => session.id)).toEqual([created.id]);

        // A reader with NO worker at all: the format did not change, and the journal is still
        // mergeable by the store that restores it.
        const resumed = inlineStore(root, database);
        const snapshot = resumed.get(created.id);

        expect(snapshot.turns.map((turn) => turn.prompt)).toEqual(['remember this']);
        expect(snapshot.turns[0].events.map((event) => (event as { type: string }).type)).toEqual(['start', 'text', 'done']);
        expect(resumed.ioWorker).toBeUndefined();
        expect(persistence.lastWriteError).toBeUndefined();
    });
});

describe('the real built entry', () => {
    it('saves, journals, fences and reloads through the store\'s own readers', async () => {
        const root = tempRoot('bundle');
        const persistence = new HarnessPersistence(root);
        const sessionId = 'bundle-session';

        const io = await createHarnessIoClient({ persistence, entry });

        clients.push(io);

        const document = {
            version: 1,
            savedAt: 1_700_000_000_000,
            registry: [],
            sessions: []
        };

        const checkpoint = await io.saveCheckpoint(document, { savedAt: 1_700_000_000_000 });

        expect(checkpoint.kind).toBe('checkpoint.save');
        expect(checkpoint.outcome).toBe('durable');
        expect(checkpoint.bytes).toBe(fs.statSync(persistence.file).size);

        expect((await io.journalOpen(sessionId)).outcome).toBe('written');
        expect(
            (
                await io.journalAppend(sessionId, {
                    turnId: 'turn-1',
                    index: 0,
                    at: 1_700_000_000_001,
                    event: { type: 'text', agent: 'one', delta: 'from the bundle' }
                })
            ).outcome
        ).toBe('written');
        expect((await io.journalFlush(sessionId)).outcome).toBe('durable');

        // The store's own reader, with no worker involved, is the judge of the bytes.
        expect(new HarnessPersistence(root).load()?.version).toBe(1);

        const read = new HarnessJournal(persistence.directory, sessionId).read();

        expect(read.events.map((record) => record.turnId)).toEqual(['turn-1']);
        expect((read.events[0]?.event as { delta: string }).delta).toBe('from the bundle');

        const closed = await io.close();

        expect(closed).toEqual({ drained: 1, failures: [] });
    });
});

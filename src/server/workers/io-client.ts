// The coordinator side of worker IO (R1/R2/R4): one FIFO durability queue per
// database root.
//
// WHAT THIS FILE IS RESPONSIBLE FOR
// ---------------------------------
// The session store stays the authority. It builds the next `HarnessDatabase` document
// and the next journal line exactly as it does inline, and then - in worker mode -
// hands them to THIS client instead of calling `persistence.save()` /
// `journal.append()`. Every "when may I answer this request" decision is made here,
// against the two rules the design is built on:
//
//   1. ORDER. Frames are posted in call order and the worker answers one at a time, so
//      a journal append reaches the file before the checkpoint that lists it, and a
//      `journal.flush` enqueued before a save fences those events (fsync) before the
//      document that references them is renamed into place - the rule ../journal.ts has
//      always relied on ("a journal line is written BEFORE the document is rewritten").
//      The client therefore never posts a frame while a deferred checkpoint is pending
//      without dealing with that checkpoint first, which keeps "the order the caller
//      called in" equal to "the order the disk sees".
//   2. NO FALSE SUCCESS. An awaited operation resolves ONLY on the worker's own success
//      receipt, and rejects with the message the inline writer would have thrown. A
//      queued operation never claims durability at all: it claims order, and its
//      failure goes to the same error channels the inline `journal.error` /
//      `persistence.lastWriteError` feed. If the worker dies, every outstanding
//      operation fails - there is no inline fallback, because a deployment that asked
//      for offloaded persistence must not end up believing a promise was kept when the
//      thread that would have kept it is gone.
//
// WHAT STILL COSTS THE MAIN THREAD (the honest limit)
// ---------------------------------------------------
//   - building the record: `databaseRecord()` and `copyEvent(event)` stay on the
//     coordinator (the authority owns the state), unchanged from inline.
//   - the structured clone `postMessage` performs on each frame: O(document) for a
//     checkpoint, O(event) for an append. Unavoidable while the coordinator owns the
//     state, and far cheaper than what it replaces (the two-space stringify of the whole
//     document plus mkdir/open/write/fsync/close/rename, all synchronous, on the loop
//     that serves every other session).
//   - so a checkpoint is bounded by `maxFrameBytes`: the client refuses to post a
//     document it already MEASURED as oversized (the worker's reply carries the exact
//     byte length, so the estimate costs nothing after the first commit), and the worker
//     re-checks the true length before touching the disk. An oversized database fails
//     loudly instead of cloning itself to death.
//
// COALESCING (why the best-effort path is cheaper here than inline ever was)
// -------------------------------------------------------------------------
// `noteStateChange` (../sessions.ts:2012) is a SYNCHRONOUS core observer and
// `checkpoint()` (../sessions.ts:3386) is interval-throttled. Neither may block, and
// neither needs THIS document to be durable - they need "the newest state eventually".
// `queueCheckpointSave` therefore holds one pending document and posts it at the end of
// the current event-loop turn, replacing it if another save is queued first. A replaced
// document is counted as `superseded` and reported as exactly that; it is never
// presented as durable. A strict save of a NEW document supersedes the pending slot too
// (same reasoning, one commit instead of two); every other operation flushes the slot
// first so ordering is never disturbed.
//
// THE SEMANTIC DIFFERENCE A REVIEWER MUST SEE (stated, not weakened):
//   - inline `persistence.save()` returns after the rename;
//   - worker `queueCheckpointSave()` returns after the document is QUEUED, and the
//     rename happens later on the worker thread. A crash inside that window loses at
//     most mutations that were never durable anywhere anyway - but the window did not
//     exist inline. Anything that must be durable before a response uses
//     `saveCheckpoint()` / `commitCheckpoint()` and AWAITS them. That is why the strict
//     call sites become async in worker mode, and it is the honest price of not blocking
//     the loop.
//
// Cross-references:
//   - ./io-protocol.ts  - the frames and the three outcomes ('durable' / 'written' /
//                         'superseded')
//   - ./io-worker.ts    - the thread that performs the writes
//   - ../persistence.ts - `HarnessPersistence`, the instance this client mirrors
//   - ../journal.ts     - `HarnessJournal`, whose per-session error state this client
//                         reproduces so the store's reporter is unchanged
//   - ./io-client.test.ts - real worker execution: ordering, barriers, error close,
//                         and byte-identity with the inline writer
//   - the integration contract the store owner implements is the block at the bottom of
//     this file

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    IO_HANDSHAKE_MS,
    IO_MAX_FRAME_BYTES,
    IO_PROTOCOL_VERSION,
    IO_WORKER_BOOT_KEY,
    createIoCallIds,
    isIoReply,
    type IoCheckpointTarget,
    type IoCommand,
    type IoJournalRecord,
    type IoJournalRewriteRecord,
    type IoOperationKind,
    type IoReply
} from './io-protocol';

// The filename the build must emit for the IO worker entry, and the package subpath a
// consumer addresses it by. `resolveIoWorkerEntry` owns the lookup chain and the exact
// message an operator gets when neither exists.
export const IO_WORKER_DIST_FILE = 'underload-harness.io-worker.mjs';
// Matches the lane worker's published subpath shape (`"./worker"` -> 
// dist/underload-harness.worker.mjs), so both worker entries are addressed the same way.
export const IO_WORKER_PACKAGE_SPECIFIER = '@underload/harness/io-worker';

// How a resolved entry will be loaded. `source` means the `.ts` entry: Node can evaluate it
// (type stripping) as long as the spawn adds `IO_WORKER_SOURCE_EXEC_ARGV` and the entry
// installs its own resolver hooks (./io-worker.ts). That is what makes worker IO usable in
// dev, under `vite-node`, and in a test run with no build - the same arrangement
// ./lane-host.ts uses for the lane worker, so the two workers load alike.
export type IoWorkerEntryMode = 'explicit' | 'env' | 'package' | 'built' | 'source';

export type IoWorkerEntry = { path: string; mode: IoWorkerEntryMode };

// The execArgv a SOURCE-mode worker needs. `persistence.ts` and `journal.ts` declare errors
// with parameter properties (`constructor(readonly file: string, ...)`), which plain type
// stripping refuses; the transform handles them.
export const IO_WORKER_SOURCE_EXEC_ARGV = ['--experimental-transform-types'];

// Bounded wait for the `bye` acknowledgement during `close()`. Operations complete
// synchronously inside the worker, so `bye` arrives as soon as the frames posted ahead
// of it have been answered; anything longer is a wedged thread. Terminating after every
// reply has already arrived cannot truncate a write.
export const IO_CLOSE_GRACE_MS = 30_000;

// Every failure in this subsystem carries this, so the store's reporter can show a code
// and a path without knowing whether the failure came from the inline writer or from a
// worker thread.
export class HarnessIoError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly path?: string,
        readonly callId?: number
    ) {
        // The message is kept verbatim: the worker's report text IS the string the inline
        // writer throws (`"<file>: Could not write the harness database: <errno>"`,
        // ../persistence.ts), and the store puts it straight into a 500
        // (`../sessions.ts:1957`). Prepending the path again would double it - and a
        // journal failure's errno text already names the path it failed on. `path` stays
        // a property, the way `HarnessJournalError` keeps `file` (../journal.ts:102).
        super(message);
        this.name = 'HarnessIoError';
    }
}

// What a successful operation reports. `outcome` is never inferred by the caller:
// 'written' means "the OS has it", 'durable' means "fsynced and atomically replaced".
export type IoWriteReceipt = {
    callId: number;
    kind: IoOperationKind;
    outcome: 'durable' | 'written';
    durationMs: number;
    bytes?: number;
};

export type IoCommitReceipt = {
    // The checkpoint itself, which is what a strict caller waits for.
    checkpoint: IoWriteReceipt;
    // Sessions whose journal tail was fsynced ahead of this checkpoint.
    fenced: string[];
};

export type IoCloseSummary = {
    // Append handles the worker fenced and released on the way out.
    drained: number;
    // Operations that never received a success receipt. Non-empty means the caller may
    // NOT claim those writes are durable.
    failures: { kind: string; message: string }[];
};

export type IoQueueStats = {
    // OPERATIONS posted to the worker (the `hello` and `shutdown` control frames are not
    // operations and are not counted). A coalesced-away checkpoint is never posted, so
    // this is also the number of commits the main thread did not have to clone. The
    // invariant an operator can check: posted = completed + failed + outstanding, with
    // `late` counting replies that arrived after their operation had been settled.
    posted: number;
    completed: number;
    failed: number;
    // Worker-side faults, and the fault that was not attributable to one operation.
    faults: number;
    lastFault?: string;
    // Best-effort checkpoints replaced by a newer document before they were posted.
    superseded: number;
    // Operations refused by a configured bound - each one reported through an error
    // channel, never dropped quietly.
    refused: number;
    // Replies that arrived for an operation already settled (a watchdog fired, the queue
    // was failed on shutdown) or a frame this build could not parse.
    late: number;
    // Bytes the worker wrote, and the last measured checkpoint size/duration: the free
    // source of the client's frame-size estimate and its off-thread cost report.
    writtenBytes: number;
    lastCheckpointBytes: number;
    lastCheckpointDurationMs: number;
    // Operations with a callId outstanding right now.
    outstanding: number;
};

export type HarnessIoClientOptions = {
    // The database this client commits to: structurally the two readonly fields of a
    // `HarnessPersistence`, so the integration is literally
    // `createHarnessIoClient({ persistence: this.persistence, ... })`.
    persistence: { directory: string; file: string };
    // Worker entry override (a built `.mjs` path or URL). Tests and custom bundling
    // inject here; production uses `resolveIoWorkerEntry`.
    entry?: string | URL;
    // Environment source for `HARNESS_IO_WORKER_ENTRY` (defaults to `process.env`).
    env?: Record<string, string | undefined>;
    handshakeMs?: number;
    // Graceful-close wait before the worker is terminated.
    closeGraceMs?: number;
    // Per-operation watchdog. 0 (the default) means no watchdog: a slow disk must not
    // become a false failure. A deployment that would rather fail a request than queue
    // behind one sets a number.
    opTimeoutMs?: number;
    maxFrameBytes?: number;
    // 0 (the default) means unbounded: a journal append is O(1) and the worker drains
    // faster than a token stream produces events. Set a number to make a stalled worker
    // REFUSE queued operations (reported, never silent) instead of growing memory.
    maxPendingOps?: number;
    // Queued checkpoint failures - the worker-mode twin of `SessionStore.notePersistenceError`
    // (../sessions.ts:1983).
    onCheckpointError?: (error: HarnessIoError) => void;
    // The worker-mode twin of `journal.error` (../journal.ts:215): the message is the
    // raw one, and the store adds its own prefix.
    onJournalError?: (sessionId: string, message: string) => void;
};

// One posted operation waiting for its reply.
type PendingOperation = {
    callId: number;
    kind: IoOperationKind;
    sessionId?: string;
    // The frame, kept so the handshake gate can write it later without rebuilding it. The
    // document is a live object, so re-reading it at release time could commit a NEWER state
    // than the caller queued; the clone happens at `postMessage`, so holding the frame costs
    // nothing until the gate opens.
    frame: IoCommand;
    // Set once the frame has actually been written to the port. A close that happens before
    // the handshake reports an unsent operation as "never performed", not "no reply".
    sent?: boolean;
    // An AWAITED operation reports failure by rejecting. A QUEUED one reports through
    // the error channels, because its caller (a core observer, an event recorder) cannot
    // react to a rejection at all.
    awaited: boolean;
    promise: Promise<IoWriteReceipt>;
    resolve: (receipt: IoWriteReceipt) => void;
    reject: (error: HarnessIoError) => void;
    timer?: ReturnType<typeof setTimeout>;
};

const positiveOr = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

const atLeastZeroOr = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

const errorText = (value: unknown): string => (value instanceof Error ? value.message : String(value));

const asIoError = (value: unknown): HarnessIoError =>
    value instanceof HarnessIoError ? value : new HarnessIoError('io-failed', errorText(value));

// ---------------------------------------------------------------------------
// Platform and entry resolution
// ---------------------------------------------------------------------------

// Node-only reachability: the IO twin of `laneWorkerEnvironment` (./capability.ts:300).
// Deliberately local - importing capability.ts would pull the lane capability surface
// and ../config.ts's error type into a durability component that needs neither.
export const ioWorkerEnvironment = (): { available: boolean; message?: string } => {
    const isNode = typeof process !== 'undefined' && process.versions?.node !== undefined;

    if (!isNode || typeof Worker !== 'function') {
        return {
            available: false,
            message:
                'This process does not provide node:worker_threads, so persistence cannot be offloaded to an IO worker. Run this server with inline persistence.'
        };
    }

    return { available: true };
};

// The sentence every entry failure ends with: what the build must emit, and the two
// ways to point elsewhere. Owned here because this client is the only party that knows
// what it looked for.
export const ioWorkerEntryHelp = (): string =>
    `Emit the worker entry from the build (a vite library entry named "io-worker" -> dist/${IO_WORKER_DIST_FILE}, ESM, node builtins external) and map it as the package subpath "${IO_WORKER_PACKAGE_SPECIFIER}", or point HARNESS_IO_WORKER_ENTRY / the "entry" option at a built file. Without a build the client falls back to the SOURCE entry (./io-worker.ts) and spawns it with ${IO_WORKER_SOURCE_EXEC_ARGV.join(' ')}; that is the dev/test path, and it is the same arrangement ./lane-host.ts uses for the lane worker.`;

// Every candidate this resolver tries, in order, with the mode it would load it in.
// Exported for the build-side check and for ./io-client.test.ts, which asserts the chain
// instead of hoping it matches the build.
export const ioWorkerEntryCandidates = (): IoWorkerEntry[] => {
    const candidates: IoWorkerEntry[] = [{ path: IO_WORKER_PACKAGE_SPECIFIER, mode: 'package' }];

    const add = (relative: string, mode: IoWorkerEntry['mode']): void => {
        try {
            candidates.push({ path: fileURLToPath(new URL(relative, import.meta.url)), mode });
        } catch {
            // A non-file URL (an exotic loader): the package specifier and the env override
            // still apply, so the chain degrades instead of throwing here.
        }
    };

    // BUNDLED: this module lives in <pkg>/dist/, beside the emitted worker entry.
    add(`./${IO_WORKER_DIST_FILE}`, 'built');

    // SOURCE CHECKOUT (vitest / vite-node): the package's own dist directory, three levels
    // up from src/server/workers.
    add(`../../../dist/${IO_WORKER_DIST_FILE}`, 'built');

    // SOURCE: the entry module itself, beside this file in a checkout...
    add('./io-worker.ts', 'source');

    // ...and, for an installed package whose `files` list ships src/, one directory up.
    add('../src/server/workers/io-worker.ts', 'source');

    return candidates;
};

// Resolves the worker entry to an existing file plus the mode to load it in, or throws a
// `worker-entry-missing` error naming everything it looked for. NO inline fallback: the
// caller that asked for worker IO gets an exception, and the store decides what that means
// for the deployment. It must not silently start blocking the event loop and call the
// result isolated.
export const resolveIoWorkerEntry = (options: { entry?: string | URL; env?: Record<string, string | undefined> } = {}): IoWorkerEntry => {
    const tried: string[] = [];

    const exists = (candidate: string): boolean => {
        tried.push(candidate);

        try {
            return fs.existsSync(candidate);
        } catch {
            return false;
        }
    };

    // 1. An explicit override wins, and a wrong one fails with its own name.
    if (options.entry !== undefined) {
        const explicit = typeof options.entry === 'string' ? options.entry : fileURLToPath(options.entry);

        if (!exists(explicit)) {
            throw new HarnessIoError('worker-entry-missing', `The configured IO worker entry does not exist: ${explicit}. ${ioWorkerEntryHelp()}`, explicit);
        }

        return { path: explicit, mode: explicit.endsWith('.ts') ? 'source' : 'explicit' };
    }

    const env = options.env ?? (typeof process === 'undefined' ? undefined : process.env);
    const fromEnv = env?.HARNESS_IO_WORKER_ENTRY;

    // 2. Operator escape hatch (a deployment that bundles the entry somewhere else).
    if (typeof fromEnv === 'string' && fromEnv.length > 0) {
        if (!exists(fromEnv)) {
            throw new HarnessIoError('worker-entry-missing', `HARNESS_IO_WORKER_ENTRY points at a file that does not exist: ${fromEnv}. ${ioWorkerEntryHelp()}`, fromEnv);
        }

        return { path: fromEnv, mode: fromEnv.endsWith('.ts') ? 'source' : 'env' };
    }

    // 3. The published package subpath, when the exports map carries it.
    try {
        const resolved = createRequire(import.meta.url).resolve(IO_WORKER_PACKAGE_SPECIFIER);

        if (exists(resolved)) return { path: resolved, mode: resolved.endsWith('.ts') ? 'source' : 'package' };
    } catch {
        // ERR_PACKAGE_PATH_NOT_EXPORTED / ERR_MODULE_NOT_FOUND: not published (yet), so the
        // local candidates below are the honest next step.
        tried.push(`require.resolve(${IO_WORKER_PACKAGE_SPECIFIER})`);
    }

    // 4/5/6/7. The built file next to this module or in the package's dist, then the source
    // entry. A build always wins over a source file: production runs the bundle.
    for (const candidate of ioWorkerEntryCandidates()) {
        if (candidate.mode === 'package') continue;

        if (exists(candidate.path)) return candidate;
    }

    throw new HarnessIoError('worker-entry-missing', `No IO worker entry was found. Looked for: ${tried.join(', ')}. ${ioWorkerEntryHelp()}`);
};

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

// Spawns the worker and returns the client SYNCHRONOUSLY, before the handshake is answered.
//
// This exists because `createHarnessRuntime` / `new SessionStore` (../runtime.ts:107,
// ../sessions.ts:1321) are synchronous today, and a worker-mode store has to be constructible
// there. Every operation issued on a not-yet-handshaked client is registered in call order and
// released the moment `hello` is confirmed, so a constructor may start a checkpoint
// immediately; whoever is allowed to block awaits `client.ready()` (the async
// `createHarnessIoClient` below is exactly that, which is why the store's startup can pick
// either shape). A handshake failure fails `ready()` and every gated operation, and terminates
// the thread - it never degrades to inline.
export const openHarnessIoClient = (options: HarnessIoClientOptions): HarnessIoClient => {
    const environment = ioWorkerEnvironment();

    if (!environment.available) {
        throw new HarnessIoError('worker-unavailable', environment.message ?? 'This host cannot run worker threads.');
    }

    const target: IoCheckpointTarget = { directory: options.persistence.directory, file: options.persistence.file };

    if (target.directory.length === 0 || target.file.length === 0) {
        throw new HarnessIoError('bad-target', 'An IO client needs the persistence directory and file it commits to.');
    }

    const maxFrameBytes = positiveOr(options.maxFrameBytes, IO_MAX_FRAME_BYTES);
    const maxPendingOps = atLeastZeroOr(options.maxPendingOps, 0);
    const resolution = resolveIoWorkerEntry({ entry: options.entry, env: options.env });
    const entry = resolution.path;

    const worker = new Worker(pathToFileURL(entry), {
        // A SOURCE entry needs Node's type transform (./io-worker.ts installs the resolver
        // hooks that go with it); a built bundle needs no execArgv at all. Same division
        // ./lane-host.ts:315 makes for the lane worker.
        ...(resolution.mode === 'source' ? { execArgv: [...IO_WORKER_SOURCE_EXEC_ARGV] } : {}),
        // The boot marker is what lets the loop attach a message loop only when THIS client
        // spawned it, so importing the loop from a test that itself runs in a worker thread
        // stays side-effect free.
        workerData: { [IO_WORKER_BOOT_KEY]: IO_PROTOCOL_VERSION, maxFrameBytes }
    });

    const callIds = createIoCallIds();
    const outstanding = new Map<number, PendingOperation>();
    const journalState = new Map<string, { lastError?: string; failures: number }>();

    let closed = false;
    let closing: Promise<IoCloseSummary> | undefined;
    let lastCheckpointError: string | undefined;
    let bye: { callId: number; resolve: (drained: number) => void; reject: (error: HarnessIoError) => void } | undefined;
    let hello: { resolve: (version: number) => void; reject: (error: HarnessIoError) => void } | undefined;

    const stats: Omit<IoQueueStats, 'outstanding'> = {
        posted: 0,
        completed: 0,
        failed: 0,
        faults: 0,
        superseded: 0,
        refused: 0,
        late: 0,
        writtenBytes: 0,
        lastCheckpointBytes: 0,
        lastCheckpointDurationMs: 0
    };

    // The one deferred best-effort checkpoint, plus whether its release is scheduled.
    // The release runs on a microtask, so a whole synchronous burst of `noteStateChange`
    // calls costs ONE clone, ONE serialization and ONE commit.
    let deferred: { document: unknown; savedAt: number } | undefined;
    let deferredScheduled = false;

    const reportCheckpointError = (error: HarnessIoError, sticky?: string): void => {
        // `persistence.lastWriteError` reports the RAW failure behind the wrapper
        // (../persistence.ts, `causeOf`), so the sticky channel gets the raw text when
        // the worker had one to give, and the composed text otherwise.
        lastCheckpointError = sticky ?? error.message;

        if (options.onCheckpointError === undefined) return;

        try {
            options.onCheckpointError(error);
        } catch {
            // A reporter must never change a run - the inline path says the same about
            // `onPersistenceError` (../sessions.ts:1990).
        }
    };

    const reportJournalError = (sessionId: string, message: string): void => {
        const state = journalState.get(sessionId) ?? { failures: 0 };

        state.lastError = message;
        state.failures += 1;
        journalState.set(sessionId, state);

        if (options.onJournalError === undefined) return;

        try {
            options.onJournalError(sessionId, message);
        } catch {
            // Same rule as the store's journal reporter (../sessions.ts:3363).
        }
    };

    // A success clears the sticky error, exactly as `journal.error` and
    // `lastWriteError` clear after a good write inline. A session with NO recorded
    // failure has nothing to clear, and must not gain a state entry from a success
    // (that would make `journalError(id)` distinguish "cleared" from "never failed" for
    // no reason).
    const clearError = (pending: PendingOperation): void => {
        if (pending.kind === 'checkpoint.save') {
            lastCheckpointError = undefined;

            return;
        }

        if (pending.sessionId === undefined) return;

        const state = journalState.get(pending.sessionId);

        if (state === undefined) return;

        state.lastError = undefined;
    };

    const disarm = (pending: PendingOperation): void => {
        if (pending.timer === undefined) return;

        clearTimeout(pending.timer);
        pending.timer = undefined;
    };

    // Routes one failure to the surface the INLINE writer would have used for it.
    //
    //   - a journal failure is reportable whether or not anyone awaited it: the store
    //     reads `journal.error` after every append (../sessions.ts:3345), so its twin
    //     `journalError(id)` / `onJournalError` has to see it in both modes, with the
    //     same text (the raw failure, ../journal.ts:215).
    //   - a checkpoint failure has two distinct inline surfaces: the THROWN message (the
    //     wrapper, which is what a 500 body carries) and
    //     `persistence.lastWriteError` (the RAW cause). `sticky` is the latter, and the
    //     callback is fired only for a QUEUED save, because an awaited save rejects and
    //     the caller reports it itself - firing both would log one failure twice.
    const noteFailure = (
        meta: { kind: IoOperationKind; sessionId?: string; awaited: boolean },
        error: HarnessIoError,
        sticky: string
    ): void => {
        if (meta.kind !== 'checkpoint.save') {
            if (meta.sessionId !== undefined) reportJournalError(meta.sessionId, error.message);

            return;
        }

        lastCheckpointError = sticky;

        if (meta.awaited || options.onCheckpointError === undefined) return;

        try {
            options.onCheckpointError(error);
        } catch {
            // A reporter must never change a run.
        }
    };

    // Fails everything the worker was going to do. On a dead thread nothing outstanding
    // can become durable, so each caller is told rather than left waiting (and a queued
    // checkpoint in the slot is reported, not silently dropped).
    const failAll = (error: HarnessIoError): void => {
        const pending = [...outstanding.values()];

        outstanding.clear();

        for (const operation of pending) {
            disarm(operation);
            operation.reject(error);
        }

        if (deferred === undefined) return;

        deferred = undefined;
        deferredScheduled = false;
        stats.superseded += 1;
        reportCheckpointError(new HarnessIoError(error.code, `A queued checkpoint was abandoned: ${error.message}`, target.file));
    };

    const settle = (reply: Extract<IoReply, { kind: 'result' | 'failure' | 'fault' }>): void => {
        const callId = reply.callId;
        const pending = callId === undefined ? undefined : outstanding.get(callId);

        if (reply.kind === 'fault' && pending === undefined) {
            // A fault naming no operation is a realm/protocol level statement. Counted
            // and remembered, because "the worker said something bad" must not vanish.
            stats.faults += 1;
            stats.lastFault = reply.message;

            return;
        }

        if (pending === undefined || callId === undefined) {
            stats.late += 1;

            return;
        }

        outstanding.delete(callId);
        disarm(pending);

        // A checkpoint reply carries the true serialized length, whether or not anything
        // was written (a size refusal still measures the document). That measurement is
        // what makes the client's frame-size guard O(1) instead of another stringify. A
        // fault names no measurement at all, so it updates nothing.
        if (pending.kind === 'checkpoint.save' && reply.kind !== 'fault') {
            if (typeof reply.bytes === 'number') stats.lastCheckpointBytes = reply.bytes;

            stats.lastCheckpointDurationMs = reply.durationMs;
        }

        if (reply.kind === 'result') {
            stats.completed += 1;

            // `writtenBytes` counts bytes that reached the file, so a refused oversized
            // document does not inflate it.
            if (typeof reply.bytes === 'number') stats.writtenBytes += reply.bytes;

            clearError(pending);

            pending.resolve({
                callId: pending.callId,
                kind: pending.kind,
                outcome: reply.outcome,
                durationMs: reply.durationMs,
                ...(reply.bytes === undefined ? {} : { bytes: reply.bytes })
            });

            return;
        }

        stats.failed += 1;

        const error =
            reply.kind === 'failure'
                ? new HarnessIoError(reply.error.code, reply.error.message, reply.error.path, pending.callId)
                : new HarnessIoError('io-fault', reply.message, undefined, pending.callId);

        if (reply.kind === 'fault') {
            stats.faults += 1;
            stats.lastFault = reply.message;
        }

        noteFailure(pending, error, reply.kind === 'failure' ? reply.error.cause ?? reply.error.message : reply.message);

        pending.reject(error);
    };

    // The frame body for one operation: the checkpoint target for a save, the journal
    // target for everything else. Centralized so a caller can never post a frame that
    // addresses the wrong file.
    const frameBody = (kind: IoOperationKind, body: Record<string, unknown>, sessionId?: string): Record<string, unknown> => {
        if (kind === 'checkpoint.save') return { target, ...body };

        return { target: { root: target.directory, sessionId: sessionId ?? '' }, ...body };
    };

    // The handshake gate. A frame written to the port before `hello` is confirmed may be
    // answered by a thread that is still importing its graph, or never answered by one that
    // failed to start - and then the operation would be reported as a per-operation timeout
    // rather than as the startup failure it is. So operations issued before the handshake are
    // REGISTERED (in call order, with their call ids already taken) and released the moment
    // the version is confirmed.
    let handshaked = false;
    const gated: PendingOperation[] = [];

    // Writes one frame and arms its watchdog. Split out of `post` because the same frame is
    // written either immediately or when the gate opens, and a gate release keeps the order
    // the caller called in (the gate is a FIFO array of already-numbered operations).
    const deliver = (pending: PendingOperation): void => {
        stats.posted += 1;

        try {
            worker.postMessage(pending.frame);
        } catch (error) {
            // A DataCloneError lands here: a value that is not structured-cloneable fails
            // THIS operation with a named reason instead of vanishing into the port, and the
            // queue stays usable.
            outstanding.delete(pending.callId);
            stats.failed += 1;

            const cloneError = new HarnessIoError('not-cloneable', `This frame could not be sent to the IO worker: ${errorText(error)}`, target.file, pending.callId);

            noteFailure(pending, cloneError, cloneError.message);
            pending.reject(cloneError);

            return;
        }

        pending.sent = true;

        if (positiveOr(options.opTimeoutMs, 0) > 0) {
            pending.timer = setTimeout(() => {
                if (!outstanding.delete(pending.callId)) return;

                stats.failed += 1;
                pending.reject(new HarnessIoError('io-timeout', `The IO worker did not answer ${pending.kind} (call ${pending.callId}) within ${options.opTimeoutMs}ms.`, target.file, pending.callId));
            }, options.opTimeoutMs as number);

            // A watchdog must never hold the process open by itself.
            pending.timer.unref?.();
        }
    };

    // Opens the gate: every operation issued before the handshake goes out now, in the order
    // it was issued, and the watchdogs start from here.
    const releaseGate = (): void => {
        handshaked = true;

        for (const pending of gated.splice(0)) deliver(pending);
    };

    // Posts one frame and returns the record of it. `meta.awaited` decides ONLY how a
    // failure is reported; the frame is identical either way, so a queued checkpoint and
    // an awaited checkpoint produce the same bytes.
    //
    // Before the handshake is confirmed the frame is REGISTERED but not written to the port
    // (`deliver` is deferred). A worker cannot answer a frame it has not imported its graph
    // far enough to receive, and a handshake that fails must fail these operations with the
    // handshake's own reason rather than a per-operation timeout. Call ids are still taken
    // in call order, so releasing the gate preserves the order the caller used.
    const post = (kind: IoOperationKind, body: Record<string, unknown>, meta: { awaited: boolean; sessionId?: string }): PendingOperation => {
        const callId = callIds();

        let resolve!: (receipt: IoWriteReceipt) => void;
        let reject!: (error: HarnessIoError) => void;

        const promise = new Promise<IoWriteReceipt>((res, rej) => {
            resolve = res;
            reject = rej;
        });

        const pending: PendingOperation = {
            callId,
            kind,
            awaited: meta.awaited,
            promise,
            resolve,
            reject,
            frame: { kind, callId, ...body } as IoCommand,
            ...(meta.sessionId === undefined ? {} : { sessionId: meta.sessionId })
        };

        // A queued failure must never surface as an unhandled rejection: the error
        // channels ARE its report.
        if (!meta.awaited) promise.catch(() => undefined);

        outstanding.set(callId, pending);

        if (!handshaked) {
            gated.push(pending);

            return pending;
        }

        deliver(pending);

        return pending;
    };

    // Releases the deferred checkpoint, if any. Runs before any other post so the FIFO
    // order the caller experienced is the order the worker executes.
    const flushDeferred = (): void => {
        const queued = deferred;

        deferred = undefined;
        deferredScheduled = false;

        if (queued === undefined) return;

        post('checkpoint.save', frameBody('checkpoint.save', { document: queued.document, savedAt: queued.savedAt }), { awaited: false });
    };

    // A strict save of a newer document makes the pending slot redundant: inline paid
    // for both commits, worker mode pays for one and says so.
    const dropDeferred = (): void => {
        if (deferred === undefined) return;

        deferred = undefined;
        deferredScheduled = false;
        stats.superseded += 1;
    };

    const scheduleDeferred = (): void => {
        if (deferredScheduled) return;

        deferredScheduled = true;

        // A microtask is the right granularity: every save queued in the same
        // synchronous turn collapses into one commit of the newest document.
        queueMicrotask(() => {
            if (!deferredScheduled) return;

            if (deferred === undefined) {
                // A strict operation released the slot first; nothing left to post.
                deferredScheduled = false;

                return;
            }

            flushDeferred();
        });
    };

    // One refusal: counted, and routed to the same surface a failure would have used.
    // The distinction from `noteFailure` alone is the counter - a refused operation never
    // reached the worker, so it is neither completed nor failed, and an operator has to
    // be able to tell "the disk refused" from "the client refused to ask".
    const refuse = (meta: { kind: IoOperationKind; sessionId?: string; awaited: boolean }, message: string, code: string): HarnessIoError => {
        stats.refused += 1;

        const error = new HarnessIoError(code, message, meta.kind === 'checkpoint.save' ? target.file : target.directory);

        noteFailure(meta, error, message);

        return error;
    };

    // The shared entry point for both flavours of every operation.
    const run = (kind: IoOperationKind, body: Record<string, unknown>, meta: { sessionId?: string; awaited: boolean }): Promise<IoWriteReceipt> => {
        const label = kind === 'checkpoint.save' ? undefined : meta.sessionId;
        const frame = { kind, ...(label === undefined ? {} : { sessionId: label }) };

        if (closed) {
            const message = `The IO client is closed, so ${kind} was not performed.`;

            if (!meta.awaited) {
                refuse({ ...frame, awaited: false }, message, 'client-closed');

                return Promise.resolve({ callId: 0, kind, outcome: 'written', durationMs: 0 });
            }

            return Promise.reject(refuse({ ...frame, awaited: true }, message, 'client-closed'));
        }

        // A queued operation cannot re-ask, so a depth bound on it is a real policy:
        // refuse with a reason. A strict operation is not refused for depth - the
        // caller's own await is the backpressure - but its refusal is still counted, so
        // "the client said no" is distinguishable from "the disk said no".
        if (!meta.awaited && maxPendingOps > 0 && outstanding.size >= maxPendingOps) {
            refuse({ ...frame, awaited: false }, `The IO queue holds ${outstanding.size} operations, at the configured limit of ${maxPendingOps}.`, 'queue-full');

            return Promise.resolve({ callId: 0, kind, outcome: 'written', durationMs: 0 });
        }

        // The O(1) frame-size pre-check, from the last MEASURED size (a size refusal still
        // measures, so one round trip is enough to learn an oversized database). A
        // document that is permanently oversized stops costing a clone; the worker's own
        // check, on the true serialized length, is what decides the first commit.
        if (kind === 'checkpoint.save' && stats.lastCheckpointBytes > maxFrameBytes) {
            const message = `The harness database measured ${stats.lastCheckpointBytes} bytes on its last measurement, above the ${maxFrameBytes} byte frame limit.`;

            if (!meta.awaited) {
                refuse({ ...frame, awaited: false }, message, 'frame-too-large');

                return Promise.resolve({ callId: 0, kind, outcome: 'written', durationMs: 0 });
            }

            return Promise.reject(refuse({ ...frame, awaited: true }, message, 'frame-too-large'));
        }

        if (kind === 'checkpoint.save' && meta.awaited) dropDeferred();
        else flushDeferred();

        return post(kind, frameBody(kind, body, label), { awaited: meta.awaited, ...(label === undefined ? {} : { sessionId: label }) }).promise;
    };

    // --- handshake -------------------------------------------------------

    const version = new Promise<number>((resolve, reject) => {
        hello = { resolve, reject };
    });

    const handshakeTimer = setTimeout(() => {
        hello?.reject(new HarnessIoError('handshake-timeout', `The IO worker entry ${entry} did not answer the protocol handshake within ${positiveOr(options.handshakeMs, IO_HANDSHAKE_MS)}ms.`, entry));
    }, positiveOr(options.handshakeMs, IO_HANDSHAKE_MS));

    handshakeTimer.unref?.();

    worker.on('message', (data: unknown) => {
        if (!isIoReply(data)) {
            // A reply this build cannot parse is a bundle/version mismatch. Counting it
            // (instead of ignoring it) is what turns "a mysteriously stuck request" into
            // a number an operator can see.
            stats.late += 1;

            return;
        }

        if (data.kind === 'hello') {
            clearTimeout(handshakeTimer);

            if (data.version !== IO_PROTOCOL_VERSION) {
                hello?.reject(
                    new HarnessIoError(
                        'protocol-version',
                        `The IO worker entry ${entry} speaks protocol version ${data.version}; this server requires ${IO_PROTOCOL_VERSION}. Rebuild the worker entry: a stale dist/ bundle against fresh sources mis-parses receipts.`,
                        entry
                    )
                );

                return;
            }

            // The gate opens BEFORE the startup promise resolves: an operation that was
            // issued during startup goes out in the order it was issued, and the caller that
            // awaited `ready` cannot observe a posted frame jumping ahead of it.
            handshaked = true;
            releaseGate();

            hello?.resolve(data.version);

            return;
        }

        if (data.kind === 'bye') {
            clearTimeout(handshakeTimer);

            // Matched by callId, never by arrival: a stray `bye` from a superseded close
            // must not settle the current one.
            if (bye === undefined || bye.callId !== data.callId) {
                stats.late += 1;

                return;
            }

            const settleBye = bye;
            bye = undefined;
            settleBye.resolve(data.drained);

            return;
        }

        settle(data);
    });

    worker.on('error', (error: Error) => {
        const reported = new HarnessIoError('worker-error', `The IO worker failed: ${error.message}`, entry);

        hello?.reject(reported);
        bye?.reject(reported);
        bye = undefined;
        failAll(reported);
    });

    worker.on('exit', (code: number) => {
        clearTimeout(handshakeTimer);

        const reported = new HarnessIoError('worker-exited', `The IO worker exited (code ${code}); its outstanding writes are not known to be durable.`, entry);

        hello?.reject(reported);

        if (bye !== undefined) {
            const settleBye = bye;

            bye = undefined;
            settleBye.reject(reported);
        }

        failAll(reported);
    });

    // The handshake request itself. Nothing else ever sends `hello`: the worker answers it
    // as its first frame, and operations issued before that answer are held behind the gate
    // above (a worker that starts and dies mid-import must fail startup, not queue work into
    // a dead port - which is what `ready` reports). Control frames are not counted in
    // `stats.posted`.
    worker.postMessage({ kind: 'hello', callId: 0 } as IoCommand);

    // `ready` is the promise the STARTUP path awaits. It is also the promise a synchronous
    // composition (a `SessionStore` constructor that cannot await) hands to whoever is
    // allowed to block - typically the server, right before it binds a port. The no-op catch
    // keeps a rejection observed by Node even when nobody awaits it, while a later `await
    // client.ready()` still rejects for the same reason.
    const ready = version.then(() => undefined);

    ready.catch(() => undefined);

    version.catch(() => {
        // A handshake that never succeeded means the thread is useless: release it, and let
        // every gated operation fail with the handshake's own reason (the `hello`/`error`/
        // `exit` handlers above have already rejected it).
        clearTimeout(handshakeTimer);

        worker.terminate().catch(() => undefined);
    });

    // --- public surface --------------------------------------------------

    const awaited = (kind: IoOperationKind, body: Record<string, unknown>, sessionId?: string): Promise<IoWriteReceipt> =>
        run(kind, body, { awaited: true, ...(sessionId === undefined ? {} : { sessionId }) });

    const queued = (kind: IoOperationKind, body: Record<string, unknown>, sessionId?: string): void => {
        void run(kind, body, { awaited: false, ...(sessionId === undefined ? {} : { sessionId }) });
    };

    const client: HarnessIoClient = {
        entry,
        persistence: { ...target },

        isOpen: () => !closed,

        // Resolves when the worker has confirmed the protocol version; rejects on a missing
        // entry, a thread that failed to start, a handshake timeout, or a version mismatch
        // (in every case the thread has already been terminated). A synchronous composition
        // that cannot await at construction time calls this before it serves a request.
        ready: () => ready,

        // ---- strict, awaited ----

        // The checkpoint a caller waits for: resolves after the worker's rename, so the
        // document is durable before the caller answers, and rejects with the message the
        // inline `save()` would have thrown.
        saveCheckpoint: (document, saveOptions) => awaited('checkpoint.save', { document, savedAt: saveOptions?.savedAt ?? Date.now() }),

        // The terminal commit shape the store needs: fence the journal tail of the
        // sessions whose events this document lists, then commit the document, and only
        // then may the response go out.
        //
        // Ordering comes from the queue (the flushes are posted first); the fence's
        // durability comes from awaiting them. A failed fence with a successful
        // checkpoint is reported as exactly that, instead of pretending nothing was
        // durable or claiming everything was.
        commitCheckpoint: async (commitOptions) => {
            // Checked here as well as in `run`: this path posts directly, and an
            // operation posted to a thread that is already closing would otherwise wait
            // for a reply that can never arrive.
            if (closed) {
                throw new HarnessIoError('client-closed', 'The IO client is closed; the checkpoint was not committed.', target.file);
            }

            const sessions = [...(commitOptions.fenceSessions ?? [])];
            const savedAt = commitOptions.savedAt ?? Date.now();

            // The commit's document is newer than anything still sitting in the slot.
            dropDeferred();

            const fences = sessions.map((sessionId) => post('journal.flush', frameBody('journal.flush', {}, sessionId), { awaited: true, sessionId }).promise);
            const checkpoint = post('checkpoint.save', frameBody('checkpoint.save', { document: commitOptions.document, savedAt }), { awaited: true });

            const [fenceResults, checkpointResult] = await Promise.all([
                Promise.allSettled(fences),
                checkpoint.promise.then((receipt) => ({ ok: true as const, receipt })).catch((error: unknown) => ({ ok: false as const, error }))
            ]);

            if (!checkpointResult.ok) throw asIoError(checkpointResult.error);

            const failed = fenceResults.find((result) => result.status === 'rejected');

            if (failed !== undefined && failed.status === 'rejected') {
                const reason = asIoError(failed.reason);

                throw new HarnessIoError(
                    reason.code === 'client-closed' ? 'client-closed' : 'journal',
                    `The checkpoint is durable, but the journal fsync ordered ahead of it failed: ${reason.message}`
                );
            }

            return { checkpoint: checkpointResult.receipt, fenced: sessions };
        },

        journalOpen: (sessionId) => awaited('journal.open', {}, sessionId),
        // An append resolves when the WORKER has written the line ('written'). Durability
        // of that line is a flush's job; the receipt always says which one it was.
        journalAppend: (sessionId, record) => awaited('journal.append', { record }, sessionId),
        journalFlush: (sessionId) => awaited('journal.flush', {}, sessionId),
        journalRewrite: (sessionId, records) => awaited('journal.rewrite', { records }, sessionId),
        journalTruncate: (sessionId) => awaited('journal.truncate', {}, sessionId),
        journalRemove: (sessionId) => awaited('journal.remove', {}, sessionId),
        journalClose: (sessionId) => awaited('journal.close', {}, sessionId),

        // Resolves when every operation enqueued BEFORE this call has finished, and
        // rejects with the first failure otherwise. A shutdown drain and any "nothing
        // may still be in flight" assertion both use this.
        barrier: async () => {
            flushDeferred();

            const pending = [...outstanding.values()];
            const results = await Promise.allSettled(pending.map((operation) => operation.promise));
            const failed = results.filter((result) => result.status === 'rejected');

            if (failed.length === 0) return;

            const first = failed[0];
            const reason = first && first.status === 'rejected' ? first.reason : undefined;

            throw new HarnessIoError('barrier-failed', `${failed.length} of ${pending.length} queued IO operations failed. First: ${errorText(reason)}`);
        },

        // ---- queued, ordered, no durability claim ----

        // The newest document wins: a replaced slot is counted as `superseded` and is
        // never presented as a durable commit.
        queueCheckpointSave: (document, saveOptions) => {
            if (closed) {
                refuse({ kind: 'checkpoint.save', awaited: false }, 'The IO client is closed, so a queued checkpoint was not performed.', 'client-closed');

                return;
            }

            if (stats.lastCheckpointBytes > maxFrameBytes) {
                refuse({ kind: 'checkpoint.save', awaited: false }, `The harness database measured ${stats.lastCheckpointBytes} bytes on its last measurement, above the ${maxFrameBytes} byte frame limit.`, 'frame-too-large');

                return;
            }

            if (deferred !== undefined) stats.superseded += 1;

            deferred = { document, savedAt: saveOptions?.savedAt ?? Date.now() };

            scheduleDeferred();
        },

        queueJournalOpen: (sessionId) => queued('journal.open', {}, sessionId),
        queueJournalAppend: (sessionId, record) => queued('journal.append', { record }, sessionId),
        queueJournalFlush: (sessionId) => queued('journal.flush', {}, sessionId),
        queueJournalRewrite: (sessionId, records) => queued('journal.rewrite', { records }, sessionId),
        queueJournalTruncate: (sessionId) => queued('journal.truncate', {}, sessionId),
        queueJournalRemove: (sessionId) => queued('journal.remove', {}, sessionId),
        queueJournalClose: (sessionId) => queued('journal.close', {}, sessionId),

        // ---- observability ----

        // `gated` is the count of registered operations still waiting for the handshake to
        // be confirmed; `operations` is everything outstanding, gated or posted.
        pending: () => ({ operations: outstanding.size, gated: gated.length, lastFrameBytes: stats.lastCheckpointBytes, coalescedCheckpoint: deferred !== undefined }),

        stats: (): IoQueueStats => ({ ...stats, outstanding: outstanding.size }),

        // The worker-mode twin of `persistence.lastWriteError` (../persistence.ts:1143).
        lastError: () => lastCheckpointError,

        // The worker-mode twins of `journal.error` / `journal.failures` (../journal.ts),
        // because the worker - not this thread - holds the handle.
        journalError: (sessionId) => journalState.get(sessionId)?.lastError,
        journalFailures: (sessionId) => journalState.get(sessionId)?.failures ?? 0,

        // Drains, asks the worker to fence its handles, waits for `bye`, then terminates
        // the thread. Resolves with what did NOT make it; it does not throw for a failed
        // write, because a dispose path cannot act on one - but it must be able to say
        // so, which is what `failures` is for.
        close: async (reason?: string): Promise<IoCloseSummary> => {
            if (closing !== undefined) return closing;

            closed = true;

            closing = (async (): Promise<IoCloseSummary> => {
                flushDeferred();

                // A close before the handshake still owes the caller an answer for the work
                // it queued: the frames go out in issue order (a live worker applies them
                // before its own `shutdown`), and if the thread never came up, the `exit`
                // handler fails them with the startup reason.
                if (!handshaked) releaseGate();

                const failures: { kind: string; message: string }[] = [];
                const waiting = [...outstanding.values()];

                let drained = 0;

                await new Promise<void>((resolve) => {
                    let done = false;
                    let timer: ReturnType<typeof setTimeout> | undefined;

                    const finish = (): void => {
                        if (done) return;

                        done = true;

                        if (timer !== undefined) clearTimeout(timer);

                        resolve();
                    };

                    const callId = callIds();

                    bye = {
                        callId,
                        resolve: (count) => {
                            drained = count;
                            finish();
                        },
                        reject: (error) => {
                            failures.push({ kind: 'close', message: error.message });
                            finish();
                        }
                    };

                    // A control frame, like `hello`: not counted in `stats.posted`.
                    try {
                        // Posted directly (not through `post`): its answer is a `bye`,
                        // not a receipt, so an outstanding operation record would only be
                        // a promise nobody settles.
                        worker.postMessage({ kind: 'shutdown', callId, reason: reason ?? 'client-close' } as IoCommand);
                    } catch (error) {
                        failures.push({ kind: 'close', message: `The shutdown frame could not be sent: ${errorText(error)}` });
                        bye = undefined;
                        finish();

                        return;
                    }

                    timer = setTimeout(() => {
                        failures.push({ kind: 'close-timeout', message: `The IO worker did not acknowledge close within ${positiveOr(options.closeGraceMs, IO_CLOSE_GRACE_MS)}ms.` });
                        finish();
                    }, positiveOr(options.closeGraceMs, IO_CLOSE_GRACE_MS));

                    timer.unref?.();
                });

                // Anything the worker was asked to do and never answered is a lost write. An
                // operation that never even reached the port (the handshake failed) is
                // reported as what it was: not performed.
                for (const operation of waiting) {
                    if (!outstanding.has(operation.callId)) continue;

                    failures.push(
                        operation.sent === true
                            ? { kind: operation.kind, message: `No reply for ${operation.kind} (call ${operation.callId}).` }
                            : { kind: operation.kind, message: `${operation.kind} (call ${operation.callId}) was never sent: the handshake did not complete.` }
                    );
                }

                failAll(new HarnessIoError('client-closed', 'The IO client was closed before this operation completed.', entry));

                // Safe by construction: every operation the worker accepted finished
                // synchronously before its reply, so terminating now cannot cut a write
                // in half - it can only drop work the worker was never told to do.
                await worker.terminate().catch(() => undefined);

                return { drained, failures };
            })();

            return closing;
        }
    };

    return client;
};

// The awaited form of `openHarnessIoClient`: resolves once the worker has confirmed the
// protocol version, and rejects (having terminated the thread) on no worker support, a
// missing entry, a worker that fails to start, a handshake timeout, or a version mismatch.
// Use this where the composition is already async; use `openHarnessIoClient` where it is not.
export const createHarnessIoClient = async (options: HarnessIoClientOptions): Promise<HarnessIoClient> => {
    const client = openHarnessIoClient(options);

    try {
        await client.ready();
    } catch (error) {
        throw error instanceof HarnessIoError ? error : new HarnessIoError('worker-start-failed', errorText(error), client.entry);
    }

    return client;
};

export type HarnessIoClient = {
    readonly entry: string;
    readonly persistence: IoCheckpointTarget;
    isOpen(): boolean;
    // Resolves when the worker has answered the protocol handshake; rejects (having already
    // terminated the thread) when it cannot. Operations issued before this settles are held
    // and then released in call order, so a synchronous store constructor may start writing
    // immediately and the server awaits `ready()` before it serves.
    ready(): Promise<void>;
    // Strict, awaited.
    saveCheckpoint(document: unknown, options?: { savedAt?: number }): Promise<IoWriteReceipt>;
    commitCheckpoint(options: { document: unknown; fenceSessions?: readonly string[]; savedAt?: number }): Promise<IoCommitReceipt>;
    barrier(): Promise<void>;
    // Journal, awaited. An append resolves when the worker has written the line
    // ('written'); making that line durable is a flush, and the receipt names which one
    // it was (./io-protocol.ts).
    journalOpen(sessionId: string): Promise<IoWriteReceipt>;
    journalAppend(sessionId: string, record: IoJournalRecord): Promise<IoWriteReceipt>;
    journalFlush(sessionId: string): Promise<IoWriteReceipt>;
    journalRewrite(sessionId: string, records: readonly IoJournalRewriteRecord[]): Promise<IoWriteReceipt>;
    journalTruncate(sessionId: string): Promise<IoWriteReceipt>;
    journalRemove(sessionId: string): Promise<IoWriteReceipt>;
    journalClose(sessionId: string): Promise<IoWriteReceipt>;
    // Queued, ordered, never throws, no durability claim.
    queueCheckpointSave(document: unknown, options?: { savedAt?: number }): void;
    queueJournalOpen(sessionId: string): void;
    queueJournalAppend(sessionId: string, record: IoJournalRecord): void;
    queueJournalFlush(sessionId: string): void;
    queueJournalRewrite(sessionId: string, records: readonly IoJournalRewriteRecord[]): void;
    queueJournalTruncate(sessionId: string): void;
    queueJournalRemove(sessionId: string): void;
    queueJournalClose(sessionId: string): void;
    // Observability.
    pending(): { operations: number; gated: number; lastFrameBytes: number; coalescedCheckpoint: boolean };
    stats(): IoQueueStats;
    lastError(): string | undefined;
    journalError(sessionId: string): string | undefined;
    journalFailures(sessionId: string): number;
    close(reason?: string): Promise<IoCloseSummary>;
};

// ---------------------------------------------------------------------------
// THE INTEGRATION CONTRACT (for the sessions.ts owner)
// ---------------------------------------------------------------------------
//
// One client per database root, created once at store construction, AFTER
// `persistence.load()` and BEFORE the server answers a request:
//
//   // synchronous store constructor (../runtime.ts:107 and ../sessions.ts:1321 are sync):
//   const io = openHarnessIoClient({
//       persistence: this.persistence,
//       onCheckpointError: (error) => this.notePersistenceError(error),
//       onJournalError: (sessionId, message) =>
//           this.noteJournalError(sessionById(sessionId), `could not append to the event journal: ${message}`)
//   });
//
//   // and where the composition can already await, the awaited form instead:
//   // const io = await createHarnessIoClient({ ...same options });
//
// Then the server awaits `io.ready()` once, before it serves: it rejects on no worker
// support, a missing entry, a thread that failed to start, a handshake timeout, or a
// protocol mismatch - and every operation issued before it settled has either been released
// in call order or failed with that same reason. Nothing ever degrades to inline silently.
//
// Writes go to the client; reads stay inline. Concretely:
//
//   1. `persistOrThrow()` (../sessions.ts:1945)
//        -> `await io.saveCheckpoint(this.databaseRecord(overrides))` inside the SAME
//           try/catch, so a failed durable commit is still a 500 carrying the same
//           message. Every caller of it becomes async; that is inherent to "durable
//           before the response" and is the only broad change worker mode needs. No
//           state-observer refactor is required (see 2).
//   2. `persistBestEffort()` (1970), `checkpoint()` (3386) and `noteStateChange()` (2012)
//        -> `io.queueCheckpointSave(this.databaseRecord())`. These are synchronous
//           observers and STAY synchronous: coalescing turns a burst of observer fires
//           into one commit. `session.core = harness.snapshot()` stays on the
//           coordinator immediately before the queue call.
//   3. `journalAppend()` (3327)
//        -> `io.queueJournalAppend(session.id, { turnId, index, at, event })`, then read
//           `io.journalError(session.id)` where the inline code reads `journal.error`.
//           Per-session ordering is preserved by the queue (the recorder's own order is
//           the file's order).
//   4. A terminal transition that must be durable before the response
//        -> `await io.commitCheckpoint({ document, fenceSessions: [session.id] })`.
//           Leaving `fenceSessions` out is byte-for-byte inline parity (no fsync the
//           inline path never performed); including it is strictly stronger.
//   5. `compactJournal` / reset -> `io.queueJournalRewrite(session.id, records)` /
//      `io.queueJournalTruncate(session.id)`; a session delete ->
//      `io.queueJournalRemove(session.id)` followed by the strict save (the queue orders
//      them, the await fences them); dispose -> `io.queueJournalClose(session.id)`.
//   6. In worker mode the coordinator must NOT write through a `HarnessJournal` it built
//      for a session the client owns (two append handles is two writers). `journal.read()`
//      and `journal.exists()` stay inline and are safe against the worker's handle
//      (../journal.ts header). `persistence.load()` is unchanged.
//   7. Shutdown: after the final strict save, `const summary = await io.close()`. A
//      non-empty `summary.failures` means those writes are NOT known durable, and must be
//      reported the way `notePersistenceError` reports one.
//   8. A client that cannot start (no worker support, no built entry, a protocol
//      mismatch, a wedged handshake) THROWS at startup. It never degrades to inline
//      silently, because then the deployment promise would be a lie.
//   9. If the worker dies mid-run, every outstanding operation rejects and the client
//      reports `isOpen() === false`. Recovery is a NEW client (restart the worker) or a
//      store-level failure; the client deliberately does not respawn on its own, because
//      an automatic respawn would hide a disk or platform problem from the operator.

// The IO worker LOOP (R1/R2/R4/R5): the coordinator's durability arm, on its own thread.
// Evaluated by ./io-worker.ts, the file a `Worker` is spawned with.
//
// WHAT THIS THREAD IS FOR
// -----------------------
// One persistent worker thread per database root, owned by the session store's IO
// client (./io-client.ts). It performs the two pieces of durability work that used to
// block the coordinator's event loop:
//
//   - the checkpoint: serialize ONE shard (R5 replaced the one whole-`HarnessDatabase`
//     document with `<dir>/index.json` plus one `session.json` and one file per thread)
//     and commit it atomically;
//   - the journal: serialize and `writeSync` one line per harness event, and fsync at
//     the boundaries the store already treats as load-bearing.
//
// The disk work is SYNCHRONOUS inside this thread on purpose. It used to be
// synchronous on the coordinator, which is what froze the server; synchronous on a
// worker keeps the one-write-at-a-time serialization the checkpoint's atomic rename
// depends on, without the event-loop cost. Making these async fs calls would let two
// writes interleave and would buy nothing, because the inbound queue is the throttle.
//
// R5 DID NOT CHANGE THIS THREAD'S AUTHORITY, ONLY ITS UNIT OF WORK
// ----------------------------------------------------------------
// The thread still owns exactly the handles and the bytes, and still decides nothing.
// What changed is that it receives one SHARD per frame instead of one document per
// frame, so the commit it performs is `serializeHarnessShard` + `writeHarnessShardFile`
// (../persistence.ts) - the same primitives the inline writer calls - and the
// whole-database stringify that used to be one 110 MB event is now one small file per
// conversation/thread. Ordering is NOT re-decided here: the client posts the units in
// `IO_SHARD_ORDER` (threads, session.json, index.json) and this queue is FIFO, so the
// thread that performs the renames cannot reorder them. A `shard.erase` frame rides that same
// FIFO, posted after the writes it follows — which is why removing a session and re-adding it in
// one commit is safe (../workers/io-client.ts `flushDeferred`).
//
// WHO OWNS WHAT (the authority does not move)
// -------------------------------------------
//   - Coordinator: harness state, `snapshot()`/`restore()`, the decision of what the
//     next shards and the next journal line are, the ORDER of operations, and every
//     response it sends. Reads (`persistence.load()`, `journal.read()`) stay synchronous
//     here, because restore runs before the server serves anything.
//   - This thread: the handles and the bytes. It caches one `HarnessJournal` per
//     session so the append handle stays open for the session's life (the inline
//     design), and it owns the staging-suffix counter shared by every shard it commits.
//   - Nobody else: a second writer of the same file is the failure mode the FIFO queue
//     exists to prevent (../journal.ts header).
//
// BYTE-IDENTITY BY CONSTRUCTION
// -----------------------------
// The worker does not reimplement the format. It calls `serializeHarnessShard` +
// `writeHarnessShardFile` (../persistence.ts) and instantiates `HarnessJournal`
// (../journal.ts) verbatim, so the shard files written in worker mode are the same
// bytes the inline path writes, and a database written by either mode is readable by
// the other. ./io-worker.test.ts asserts that equality per shard on real files.
//
// WHY THIS IS THE LOOP, NOT THE ENTRY
// -----------------------------------
// `./io-worker.ts` is the file a `Worker` is spawned with: it installs the source-mode
// resolver hooks and then evaluates THIS module. The split is forced by module semantics -
// an entry's own static imports are resolved before its body runs, so hooks registered in
// that body would be too late for them (./lane-worker.ts makes the same split for the lane
// worker, and for the same reason).
//
// `executeIoCommand` is the operation table minus the port, so a test can drive it
// in-process (fast, deterministic error injection - ./io-worker.test.ts) while
// ./io-client.test.ts drives it through a REAL worker thread for the ordering, barrier,
// close and round-trip acceptance. The self-start guard at the bottom means this module
// only attaches a listener when ./io-client.ts spawned it, so importing it from a test
// that itself runs inside a worker thread has no side effect.
//
// Cross-references:
//   - ./io-worker.ts      - the entry: source hooks, then this module
//   - ./io-protocol.ts    - the frames, the three outcomes, the ordering contract
//   - ./io-client.ts      - the coordinator side: queue, per-path coalescing, barrier
//   - ../persistence.ts   - the shared commit primitives (`serializeHarnessShard`)
//   - ../journal.ts       - `HarnessJournal`, instantiated here unchanged
//   - ./worker-boot.mjs   - the plain-JS entry the thread is spawned with
//   - ./worker-runner.ts  - the parent-side Vite server that resolves and transforms this graph

import { isMainThread, parentPort, threadId, workerData, type MessagePort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { HarnessJournal } from '../journal';
import type { JournalEventRecord } from '../journal';
import { createHarnessStagingSequence, eraseHarnessShardPaths, harnessShardCommitStampOf, harnessShardDigest, harnessShardFileOf, harnessShardStampOf, serializeHarnessShard, writeHarnessShardFile } from '../persistence';
import type { HarnessShardCommitStamp, HarnessShardUnit } from '../persistence';
import {
    IO_DURABLE_OUTCOMES,
    IO_MAX_FRAME_BYTES,
    IO_PROTOCOL_VERSION,
    IO_WORKER_BOOT_KEY,
    describeIoFrame,
    ioErrorReportOf,
    ioFaultCallId,
    ioJournalKey,
    isIoCommand,
    type IoCommand,
    type IoErrorReport,
    type IoJournalTarget,
    type IoOperation,
    type IoOperationKind,
    type IoReply,
    type IoShardTarget
} from './io-protocol';

// Worker identity inside the shard's staging name. A worker thread shares
// `process.pid` with the coordinator, so the pid alone cannot separate a worker's
// `session.json.<pid>.0.tmp` from a coordinator's: the `.io<threadId>` suffix is what
// keeps two in-process writers from ever naming the same staging file.
const stagingOwner = `${process.pid}.io${threadId}`;

// ONE counter for every shard this thread commits. Staging names only have to be unique
// inside their own directory (the commit is a same-directory rename), and a single
// monotonic counter shared across directories is strictly stronger than one per file,
// while keeping the crash-never-reuses-a-stale-staging-file rule the whole thread holds.
const stagingSequence = createHarnessStagingSequence();

// Held journal handles, keyed by (root, sessionId) - the worker's mirror of the store's
// one-live-journal-per-session rule (../sessions.ts:5577-5579, `attachJournal` returns the
// handle it already attached instead of building a second one). `close` and `remove` drop the
// entry, exactly as the store discards its instance.
const journals = new Map<string, HarnessJournal>();

// ---------------------------------------------------------------------------
// Worker-side skip gate
// ---------------------------------------------------------------------------

// Resolved shard path -> the stamp of the bytes THIS worker last committed there. It exists for
// exactly one reason: `runShardSave` is the place that holds the serialized bytes, so it is the
// only place that can notice "these bytes are already on disk" and skip the write. Doing that on
// the coordinator instead would mean handing the payload back to the main thread, which is the
// stringify this mode exists to move off the loop.
//
// Like the coordinator's `HarnessPersistence.shardDigests` (../persistence.ts), it is a cache of
// this worker's own writes: the file witness is what makes the skip honest, and every entry goes
// with the file it describes (an erase, or `journal.remove` deleting a whole session directory).
// A restart starts empty, which costs one write per shard and never correctness.
//
// Keyed by the path STRING, not `path.resolve`: both sides of every key here are produced by the
// same `harness*FileOf`/`harness*DirectoryOf` derivations from the same persistence directory string
// (the coordinator builds the erase frame's paths, this thread builds a save frame's target), so
// textual identity IS file identity — and this thread deliberately imports no `node:path`, keeping
// every filesystem decision in ../persistence.ts.
const committedShards = new Map<string, HarnessShardCommitStamp>();

const forgetShardCommit = (file: string): void => {
    committedShards.delete(file);
};

// True when `file` is INSIDE `directory` (not merely prefixed by it — `sessions/<id>` is a textual
// prefix of `sessions/<id>-backup`, and both separators are accepted because the path strings this
// thread sees are built on the coordinator's platform).
const shardFileUnder = (file: string, directory: string): boolean => {
    if (!file.startsWith(directory) || file.length <= directory.length) return false;

    const separator = file[directory.length];

    return separator === '/' || separator === '\\';
};

// Drops every stamp under a directory that was just removed. Without this, a transcript deleted
// behind the map's back would keep its stamp, and the next save of that conversation would skip the
// write and leave the file MISSING under a digest that claims it is there.
const forgetShardCommitsUnder = (directory: string): void => {
    for (const key of [...committedShards.keys()]) {
        if (shardFileUnder(key, directory)) committedShards.delete(key);
    }
};

// Run-time limits. `configureIoWorker` lets a deployment (or a test) lower the frame
// bound without a rebuild; the default is the protocol constant.
let limits: { maxFrameBytes: number } = { maxFrameBytes: IO_MAX_FRAME_BYTES };

export const configureIoWorker = (next: Partial<{ maxFrameBytes: number }>): { maxFrameBytes: number } => {
    if (typeof next.maxFrameBytes === 'number' && Number.isFinite(next.maxFrameBytes) && next.maxFrameBytes > 0) {
        limits = { maxFrameBytes: next.maxFrameBytes };
    }

    return { ...limits };
};

export const ioWorkerLimits = (): { maxFrameBytes: number } => ({ ...limits });

// How many append handles are still held: the `bye` frame reports this, so a shutdown
// can show how much unfenced journal tail existed.
export const ioWorkerOpenJournals = (): number => journals.size;

// Get-or-attach one session's journal. The construction is the store's own
// (`new HarnessJournal(persistence.directory, session.id)`), so the directory layout
// cannot drift between modes.
const journalFor = (target: IoJournalTarget): HarnessJournal => {
    const key = ioJournalKey(target);
    const existing = journals.get(key);

    if (existing !== undefined) return existing;

    const journal = new HarnessJournal(target.root, target.sessionId);

    journals.set(key, journal);

    return journal;
};

// A journal failure, reported the way the store reports it: `journal.error` holds the
// raw message and the store adds its own prefix (../sessions.ts:5647), so the reply's
// `message` must be exactly that string for both modes to read alike. `journal.error`
// is cleared by every success, and the worker is single-threaded, so reading it
// immediately after an operation describes THIS operation.
const journalOutcome = (journal: HarnessJournal): { error?: IoErrorReport } => {
    const message = journal.error;

    if (message === undefined) return {};

    return { error: { message, code: 'journal', path: journal.file } };
};

// Runs one journal operation. Every call is synchronous, and the outcome is read
// right after it.
const runJournalOperation = (kind: IoOperationKind, frame: Record<string, unknown>): { error?: IoErrorReport } => {
    const target = frame.target as IoJournalTarget;
    const journal = journalFor(target);

    if (kind === 'journal.open') {
        journal.open();

        return journalOutcome(journal);
    }

    if (kind === 'journal.append') {
        const record = frame.record as { turnId: string; index: number; at: number; event: unknown };

        // `append` refuses (false) instead of throwing, and it opens first, so a false
        // answer means the line is NOT in the file.
        // The event crosses as `unknown` so this worker's type surface never pulls the
        // harness runtime into a fs-only bundle; the journal's own record type is the
        // authority on what a reader accepts, and it validates on read (../journal.ts).
        const written = journal.append({
            turnId: record.turnId,
            index: record.index,
            at: record.at,
            event: record.event as JournalEventRecord['event']
        });

        if (written) return {};

        return { error: { message: journal.error ?? 'the journal refused the append', code: 'journal', path: journal.file } };
    }

    if (kind === 'journal.flush') {
        journal.flush();

        return journalOutcome(journal);
    }

    if (kind === 'journal.rewrite') {
        journal.rewrite(frame.records as readonly JournalEventRecord[]);

        return journalOutcome(journal);
    }

    if (kind === 'journal.truncate') {
        journal.truncate();

        return journalOutcome(journal);
    }

    if (kind === 'journal.remove') {
        // The session directory this journal lives in — `journal.remove()` deletes it wholesale
        // (../journal.ts:505-510), shard files included, so the stamps under it must go with it.
        // This IS the session's shard directory: `HARNESS_SESSION_DIRECTORY` is
        // `HARNESS_JOURNAL_DIRECTORY` by construction (../persistence.ts:217).
        const sessionDirectory = journal.directory;

        journal.remove();
        // A deleted session must not keep a handle the next `append` would resurrect
        // onto a recreated directory (../sessions.ts:11457 discards the instance too).
        journals.delete(ioJournalKey(target));
        // Without this, the next save of that id would find a stamp for a file that no longer
        // exists, skip the write, and leave the shard MISSING behind a digest claiming it is there.
        forgetShardCommitsUnder(sessionDirectory);

        return journalOutcome(journal);
    }

    // 'journal.close': fsync + release the handle, keep the log (../sessions.ts:11454-11455 is
    // the store's own close-then-discard, which this mirrors through the queue).
    journal.close();
    journals.delete(ioJournalKey(target));

    return journalOutcome(journal);
};

// The shard commit: serialize (the cost the coordinator used to pay), then the atomic
// replace of THAT shard's own file.
//
// One unit per frame, deliberately: a commit is several calls to this function, posted in
// `IO_SHARD_ORDER`, and each one either reaches its own durability boundary or fails
// naming itself. Nothing here knows the shard FORMAT - `serializeHarnessShard` and
// `writeHarnessShardFile` are the same primitives the inline writer uses, so worker mode
// and inline mode cannot produce two different files for one unit.
//
// `skipped: true` says the bytes were already on disk and nothing was written. It is reported to
// the coordinator for its statistics only; the durability outcome is identical either way.
const runShardSave = (unit: HarnessShardUnit, target: IoShardTarget): { error?: IoErrorReport; bytes: number; skipped?: boolean } => {
    // The frame's `savedAt` is deliberately NOT read here: the stamp is the COORDINATOR's
    // instant (one per commit) and it already lives inside the INDEX unit's document
    // (`harnessIndexDocumentOf(database, savedAt)`). Re-stamping in the worker would make a
    // commit's shards disagree about which state they describe.
    if (harnessShardFileOf(unit) !== target.file) {
        // Layout drift between the two sides: the coordinator spelled the destination with
        // A1's own primitives, so a mismatch means the client and the worker were loaded
        // from different checkouts (or one side invented a path). Refusing beats writing
        // somewhere the reader will not look.
        return {
            bytes: 0,
            error: {
                code: 'shard-layout',
                message: `The ${target.kind} shard target ${target.file} does not match the unit this frame carries (${harnessShardFileOf(unit)}).`,
                path: target.file
            }
        };
    }

    const payload = serializeHarnessShard(unit);

    // Exact-size guard, measured where the truth is: after serialization, before any
    // syscall. The client pre-checks with its last measured size FOR THIS PATH so a
    // permanently oversized shard stops paying the clone; this is the check that decides.
    //
    // The subject of the message is the SHARD, named by path: under R5 "the harness
    // database" is several files, and an operator told "the database is too big" would go
    // looking for one file that does not exist.
    if (payload.length > limits.maxFrameBytes) {
        return {
            bytes: payload.length,
            error: {
                code: 'frame-too-large',
                message: `The ${target.kind} shard ${target.file} is ${payload.length} bytes, above the ${limits.maxFrameBytes} byte IO frame limit.`,
                path: target.file
            }
        };
    }

    // Two conditions must both hold to skip this write, and the second one is what keeps the skip
    // honest — the same pair `HarnessPersistence.commitShardIfChanged` enforces inline
    // (../persistence.ts), and this is the only place it CAN be enforced in worker mode: the
    // coordinator does not hold these bytes, this function just produced them.
    //
    //   1. the serialized payload hashes to the bytes this worker last committed at that path, and
    //   2. the FILE still carries the witness (`size` + `mtimeMs`) it had at that commit.
    //
    // Condition 1 alone cannot see an edit made to the file from OUTSIDE this process — the hash is
    // of the writer's own bytes, which did not change — and skipping such a file would keep the
    // store's belief and the file's bytes apart until a restart adopted the outsider's bytes as
    // truth. Condition 2 restores that self-heal for the price of one `statSync`. A file that
    // cannot be statted at all counts as CHANGED: a rewrite is always safe, a wrong skip is not.
    const key = target.file;
    const digest = harnessShardDigest(payload);
    const committed = committedShards.get(key);

    if (committed !== undefined && committed.digest === digest) {
        const current = harnessShardStampOf(target.file);

        if (current !== undefined && current.size === committed.size && current.mtimeMs === committed.mtimeMs) {
            // `skipped` is carried ONLY on a skip, so a reply that says nothing is an ordinary
            // write — the flag stays additive for a peer that never sets it.
            return { bytes: payload.length, skipped: true };
        }
    }

    // Throws `HarnessPersistenceError` naming the file. Its message is what the inline
    // path throws, so a 500 in worker mode reads exactly like a 500 inline. The measured
    // `payload` rides into the writer (the same hand-off `commitShardIfChanged` uses
    // inline), so the bytes that were sized are exactly the bytes committed - a second
    // `JSON.stringify` could in principle differ.
    //
    // A throw deliberately propagates (the dispatcher turns it into a `failure` for THIS unit,
    // with no `bytes` claim). Nothing is recorded in the map then, which is correct: the entry
    // still describes the bytes that are actually on disk, and a payload that hashes to it is a
    // payload the disk already has.
    writeHarnessShardFile({ ...unit, payload } as HarnessShardUnit, { owner: stagingOwner, sequence: stagingSequence });

    committedShards.set(key, harnessShardCommitStampOf(target.file, digest, payload));

    return { bytes: payload.length };
};

// Remove the shards a commit stopped naming — the worker twin of the inline
// `eraseVanishedShards`, so a session dropped from the document leaves the same bytes behind in
// both modes (its `session.json` and its `threads/` tree gone, its `events.jsonl` kept).
//
// The worker holds no session identity, which is why the COORDINATOR computes the exact paths — one
// file per vanished session, one tree per session whose conversation set shrank — and this handler
// stays as layout-agnostic as every other handler there is. It does not touch `fs` either: the
// removal is ../persistence.ts's `eraseHarnessShardPaths`, the same primitive the inline collector
// calls, so "erased" cannot come to mean two different things in the two modes.
//
// Durability is deliberately NO STRONGER than inline: the index already says the row is gone, so a
// failed unlink is reported (a `failure` for this callId, which the client counts and does NOT put
// on the sticky channel) while the leftover bytes cost disk, not correctness. The primitive's
// `force: true` makes a file that is already gone a success, which is what makes this frame
// idempotent — a re-post cannot turn a completed removal into a failure.
const runShardErase = (operation: Extract<IoOperation, { kind: 'shard.erase' }>): { error?: IoErrorReport } => {
    const failed = eraseHarnessShardPaths(operation.files, operation.trees);

    // Whether or not an unlink worked, no stamp may survive for anything under these paths: as far
    // as the committed header the file is gone, and the next save of that id has to WRITE it again
    // rather than skip against bytes that are no longer there.
    for (const file of operation.files) forgetShardCommit(file);
    for (const tree of operation.trees) forgetShardCommitsUnder(tree);

    if (failed.length === 0) return {};

    return {
        error: {
            code: 'shard-erase',
            // One `<path>: <reason>` entry per failure. Node's own reason text may name the path
            // again (every fs error does), which is not the v2 problem this fixes: v2 spelled the
            // path twice IN ITS OWN WORDS, so one failed unlink read like two different failures.
            message: `Could not erase ${failed.length} shard${failed.length === 1 ? '' : 's'} a commit stopped naming: ${failed.map((entry) => `${entry.path}: ${entry.message}`).join('; ')}`,
            // R5 again: the subject is the shard that failed, not "the database".
            path: failed[0]!.path
        }
    };
};

// One command in, one reply out. It never throws: a fault inside an operation becomes
// a `failure` for that callId and an unrecognizable frame becomes a `fault`, so the
// coordinator is never left waiting on a frame that produced no answer.
export const executeIoCommand = (data: unknown): IoReply => {
    const started = performance.now();

    if (!isIoCommand(data)) {
        // Attributed to its callId whenever the rejected frame still names one: a fault
        // that names no operation is a fault the caller cannot be told about, and an
        // awaited operation waiting on it would hang (./io-protocol.ts `ioFaultCallId`).
        const callId = ioFaultCallId(data);

        return { kind: 'fault', ...(callId === undefined ? {} : { callId }), message: `Unrecognized IO frame: ${describeIoFrame(data)}.` };
    }

    const command = data as IoCommand;

    if (command.kind === 'hello') {
        return { kind: 'hello', callId: 0, version: IO_PROTOCOL_VERSION, ok: true };
    }

    if (command.kind === 'shutdown') {
        // Fence and release every held append handle on the way out. Operations run
        // synchronously, so an inbound `shutdown` means everything posted before it has
        // already been applied: nothing can be in flight here.
        let drained = 0;

        for (const [key, journal] of [...journals]) {
            journal.close();
            journals.delete(key);
            drained += 1;
        }

        return { kind: 'bye', callId: command.callId, ok: true, drained };
    }

    try {
        // A removal is dispatched BEFORE the size guard, which is right: it carries no payload, so
        // it cannot be oversized, and it is the one operation whose "nothing to do" case (the file
        // is already gone) is a SUCCESS rather than a refusal.
        if (command.kind === 'shard.erase') {
            const outcome = runShardErase(command as Extract<IoOperation, { kind: 'shard.erase' }>);

            if (outcome.error !== undefined) {
                return { kind: 'failure', callId: command.callId, ok: false, error: outcome.error, durationMs: performance.now() - started };
            }

            return { kind: 'result', callId: command.callId, ok: true, outcome: IO_DURABLE_OUTCOMES['shard.erase'], durationMs: performance.now() - started };
        }

        if (command.kind === 'shard.save') {
            // Inside the try on purpose: `serializeHarnessShard` can itself throw
            // (a circular or BigInt value in a record), and that is a failure of THIS
            // unit, not a fault of the realm. It is also ONLY a failure of this unit: the
            // other shards of the same commit are separate frames and commit normally.
            const outcome = runShardSave(command.unit as HarnessShardUnit, command.target);

            if (outcome.error !== undefined) {
                // `bytes` rides along even on a refusal: the worker has just measured the
                // true size of THIS shard, and the client feeds that back into its own
                // per-path size guard so an oversized conversation stops costing a clone on
                // the main thread (no commit happened, so no bytes were written).
                return {
                    kind: 'failure',
                    callId: command.callId,
                    ok: false,
                    error: outcome.error,
                    durationMs: performance.now() - started,
                    bytes: outcome.bytes
                };
            }

            return {
                kind: 'result',
                callId: command.callId,
                ok: true,
                outcome: IO_DURABLE_OUTCOMES['shard.save'],
                durationMs: performance.now() - started,
                bytes: outcome.bytes,
                // Present only on a skip. The OUTCOME is the same either way — the bytes are
                // durable — so nothing that answers a frame branches on it; the coordinator uses it
                // for one number in its own report (`stats.skippedShards`).
                skipped: outcome.skipped
            };
        }

        const outcome = runJournalOperation(command.kind, command as unknown as Record<string, unknown>);

        if (outcome.error !== undefined) {
            return { kind: 'failure', callId: command.callId, ok: false, error: outcome.error, durationMs: performance.now() - started };
        }

        return {
            kind: 'result',
            callId: command.callId,
            ok: true,
            outcome: IO_DURABLE_OUTCOMES[command.kind],
            durationMs: performance.now() - started
        };
    } catch (error) {
        return {
            kind: 'failure',
            callId: command.callId,
            ok: false,
            error: ioErrorReportOf(error),
            durationMs: performance.now() - started
        };
    }
};

// Attaches the message loop to a port. Exported so a test can drive the loop over a
// `MessageChannel` without a thread, which keeps the self-start guard below the only
// place that decides "am I the worker?".
export const runIoWorker = (port: MessagePort): void => {
    port.on('message', (data: unknown) => {
        const reply = executeIoCommand(data);

        port.postMessage(reply);

        if (reply.kind === 'bye') {
            // Release the port so the thread can exit on its own. The client still
            // terminates as a safety net, and terminating after `bye` is safe: every
            // operation completed synchronously before its reply was posted.
            port.close();
        }
    });
};

// Starts this loop on the current thread, and only when ./io-client.ts spawned it (its
// `workerData` carries the protocol version as the boot marker). Returns false otherwise,
// so a test that imports this module - even one running inside vitest's thread pool, where
// `parentPort` is a real port - sees no side effect.
//
// WHY THE ENTRY CALLS THIS INSTEAD OF THIS MODULE SELF-STARTING
// -------------------------------------------------------------
// The package manifest declares `"sideEffects": false`, so a bundler may drop a module
// whose exports nobody uses - and it does. An entry that only ran
// `await import('./io-worker-loop.ts')` compiled to a 1 KB file that never loaded this
// module at all, and the worker exited with code 0 without ever answering `hello`
// (measured). Calling an exported function from the entry makes the work observable to the
// bundler, and keeps one readable source for both load modes.
export const startIoWorker = (): boolean => {
    const boot = workerData as { [key: string]: unknown } | undefined;

    if (isMainThread || parentPort === null || boot?.[IO_WORKER_BOOT_KEY] !== IO_PROTOCOL_VERSION) return false;

    if (typeof boot?.maxFrameBytes === 'number') configureIoWorker({ maxFrameBytes: boot.maxFrameBytes });

    runIoWorker(parentPort);

    return true;
};

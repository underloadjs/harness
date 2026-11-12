// The IO worker LOOP (R1/R2/R4): the coordinator's durability arm, on its own thread.
// Evaluated by ./io-worker.ts, the file a `Worker` is spawned with.
//
// WHAT THIS THREAD IS FOR
// -----------------------
// One persistent worker thread per database root, owned by the session store's IO
// client (./io-client.ts). It performs the two pieces of durability work that used to
// block the coordinator's event loop:
//
//   - the checkpoint: serialize the WHOLE `HarnessDatabase` document (a two-space
//     pretty-print, O(every session's every event)) and commit it atomically;
//   - the journal: serialize and `writeSync` one line per harness event, and fsync at
//     the boundaries the store already treats as load-bearing.
//
// The disk work is SYNCHRONOUS inside this thread on purpose. It used to be
// synchronous on the coordinator, which is what froze the server; synchronous on a
// worker keeps the one-write-at-a-time serialization the checkpoint's atomic rename
// depends on, without the event-loop cost. Making these async fs calls would let two
// writes interleave and would buy nothing, because the inbound queue is the throttle.
//
// WHO OWNS WHAT (the authority does not move)
// -------------------------------------------
//   - Coordinator: harness state, `snapshot()`/`restore()`, the decision of what the
//     next document/journal line is, the ORDER of operations, and every response it
//     sends. Reads (`persistence.load()`, `journal.read()`) stay synchronous here,
//     because restore runs before the server serves anything.
//   - This thread: the handles and the bytes. It caches one `HarnessJournal` per
//     session so the append handle stays open for the session's life (the inline
//     design), and it owns the checkpoint's staging-suffix counter.
//   - Nobody else: a second writer of the same file is the failure mode the FIFO queue
//     exists to prevent (../journal.ts header).
//
// BYTE-IDENTITY BY CONSTRUCTION
// -----------------------------
// The worker does not reimplement the format. It calls `serializeHarnessDatabase` +
// `writeHarnessDatabaseFile` (../persistence.ts) and instantiates `HarnessJournal`
// (../journal.ts) verbatim, so `state.json` and `events.jsonl` written in worker mode
// are the same bytes the inline path writes, and a database written by either mode is
// readable by the other. ./io-client.test.ts asserts that equality on real files.
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
//   - ./io-client.ts      - the coordinator side: queue, coalescing, barrier, failure
//   - ../persistence.ts   - the shared commit primitives
//   - ../journal.ts       - `HarnessJournal`, instantiated here unchanged
//   - ./worker-boot.mjs   - the plain-JS entry the thread is spawned with
//   - ./worker-runner.ts  - the parent-side Vite server that resolves and transforms this graph

import { isMainThread, parentPort, threadId, workerData, type MessagePort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { HarnessJournal } from '../journal';
import type { JournalEventRecord } from '../journal';
import { createHarnessStagingSequence, serializeHarnessDatabase, writeHarnessDatabaseFile } from '../persistence';
import type { HarnessDatabase } from '../persistence';
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
    type IoCheckpointTarget,
    type IoCommand,
    type IoErrorReport,
    type IoJournalTarget,
    type IoOperationKind,
    type IoReply
} from './io-protocol';

// Worker identity inside the checkpoint's staging name. A worker thread shares
// `process.pid` with the coordinator, so the pid alone cannot separate a worker's
// `state.json.<pid>.0.tmp` from a coordinator's: the `.io<threadId>` suffix is what
// keeps two in-process writers from ever naming the same staging file.
const stagingOwner = `${process.pid}.io${threadId}`;
const stagingSequence = createHarnessStagingSequence();

// Held journal handles, keyed by (root, sessionId) - the worker's mirror of the
// store's one-live-journal-per-session rule (../sessions.ts:3311). `close` and
// `remove` drop the entry, exactly as the store discards its instance.
const journals = new Map<string, HarnessJournal>();

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
// raw message and the store adds its own prefix (../sessions.ts:3347), so the reply's
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
        journal.remove();
        // A deleted session must not keep a handle the next `append` would resurrect
        // onto a recreated directory (../sessions.ts:6842 discards the instance too).
        journals.delete(ioJournalKey(target));

        return journalOutcome(journal);
    }

    // 'journal.close': fsync + release the handle, keep the log (../sessions.ts:6954).
    journal.close();
    journals.delete(ioJournalKey(target));

    return journalOutcome(journal);
};

// The checkpoint commit: serialize (the cost the coordinator used to pay), then the
// atomic replace.
const runCheckpointSave = (document: unknown, savedAt: number, target: IoCheckpointTarget): { error?: IoErrorReport; bytes: number } => {
    const payload = serializeHarnessDatabase(document as HarnessDatabase, savedAt);

    // Exact-size guard, measured where the truth is: after serialization, before any
    // syscall. The client pre-checks with its last measured size so a permanently
    // oversized database stops paying the clone; this is the check that decides.
    if (payload.length > limits.maxFrameBytes) {
        return {
            bytes: payload.length,
            error: {
                code: 'frame-too-large',
                message: `The harness database is ${payload.length} bytes, above the ${limits.maxFrameBytes} byte IO frame limit.`,
                path: target.file
            }
        };
    }

    // Throws `HarnessPersistenceError` naming the file. Its message is what the inline
    // path throws, so a 500 in worker mode reads exactly like a 500 inline.
    writeHarnessDatabaseFile(target.directory, target.file, payload, { owner: stagingOwner, sequence: stagingSequence });

    return { bytes: payload.length };
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
        if (command.kind === 'checkpoint.save') {
            // Inside the try on purpose: `serializeHarnessDatabase` can itself throw
            // (a circular or BigInt value in a record), and that is a failure of THIS
            // operation, not a fault of the realm.
            const outcome = runCheckpointSave(command.document, command.savedAt, command.target);

            if (outcome.error !== undefined) {
                // `bytes` rides along even on a refusal: the worker has just measured the
                // true document size, and the client feeds that back into its own
                // frame-size guard so an oversized database stops costing a clone on the
                // main thread (no commit happened, so no bytes were written).
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
                outcome: IO_DURABLE_OUTCOMES['checkpoint.save'],
                durationMs: performance.now() - started,
                bytes: outcome.bytes
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

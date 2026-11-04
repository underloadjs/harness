// IO-worker wire protocol (R1/R2/R4): the data-only frames the session coordinator
// and the ONE persistence/journal worker exchange.
//
// WHY A SEPARATE WORKER FROM THE LANE WORKERS
// -------------------------------------------
// The lane workers (../workers/protocol.ts) isolate a thread's TURN CPU. They do not
// touch durability: `harness.snapshot()` and `harness.restore()` stay on the
// coordinator, which means the checkpoint's full-document `JSON.stringify` and the
// journal's per-event serialize+`writeSync` stayed on the coordinator too, blocking
// the event loop that serves every other session and every SSE stream.
//
// This worker is the other half of isolation: it owns the WRITE SIDE of the durable
// state. It does not own the state. The coordinator remains the single authority -
// it decides what the next document and the next journal line are, in what order, and
// whether a response may be sent. Everything sent here is data, and everything that
// comes back is a receipt, never a state decision.
//
// ORDERING CONTRACT (the load-bearing part)
// -----------------------------------------
//   - One worker, one inbound message queue, and frames are processed strictly in the
//     order they were posted. A worker frame never starts before the previous one has
//     COMPLETED, because every operation inside the worker is synchronous (`fs.*Sync`)
//     and the dispatcher awaits nothing mid-operation.
//   - Therefore: `journal.append` of event N is on disk before the checkpoint that
//     lists event N, and a `journal.flush` enqueued before a save fences that append
//     (fsync) before the document that references it is renamed into place. The
//     checkpoint-must-not-overtake-the-journal rule from ../journal.ts:3461 holds by
//     construction instead of by caller discipline.
//   - A `callId` names every reply. Nothing is matched by arrival order on the way
//     back either, so a late reply from a superseded client is still attributed
//     correctly (and dropped with a reason if its op was already settled).
//
// DURABILITY CONTRACT (no fire-and-forget claims)
// -----------------------------------------------
// A result names its outcome explicitly, and the three outcomes mean different things:
//   - 'durable'   - the operation reached its durability boundary (checkpoint: fsynced
//                   staging + rename; journal flush: fsync; rewrite: fsync + rename).
//   - 'written'   - the bytes were handed to the OS through a held fd (append), i.e.
//                   safe across a PROCESS crash and exactly as strong as the inline
//                   writer has always been, but NOT fenced against a power loss until
//                   a 'durable' flush names them. A caller must not read this as a
//                   durability claim.
//   - 'superseded'- resolved by the COORDINATOR without a round trip: a newer
//                   best-effort checkpoint replaced this one in the queue, so this
//                   exact document was never written. Honest, not silent: the caller
//                   that asked for a barrier still fences on the newer document.
// A failed operation answers `ok: false` with the message the synchronous path would
// have thrown. Nothing answers `ok: true` for a document that is not durable, and a
// worker that dies answers NOTHING - the client fails every outstanding operation.
//
// WHAT IS DELIBERATELY NOT HERE
// -----------------------------
//   - No live handles: an fd, a stream and an Error object do not cross. The worker
//     re-derives every path from data (`root` + `sessionId`, `directory` + `file`) and
//     flattens every failure to `{ message, code, path }`.
//   - No reads on the worker path. `persistence.load()` and `journal.read()` stay
//     synchronous on the coordinator, because they run during restore BEFORE the
//     server answers anything, and the checkpoint is the reader's source of truth.
//     Routing them here would serialize a restore behind a pending compaction for no
//     gain. `exists()`/`read()` on a coordinator-side `HarnessJournal` stay safe while
//     the worker holds the append fd (Node opens with read sharing).
//   - No leniency for unknown frames: `describeIoFrame` names the offender, because a
//     silently ignored frame later looks like a request that never returned.
//
// Cross-references:
//   - ./io-worker.ts        - the worker side: the dispatcher and its self-start guard
//   - ./io-client.ts        - the coordinator side: FIFO queue, coalescing, barrier
//   - ../persistence.ts     - `serializeHarnessDatabase` / `writeHarnessDatabaseFile`
//   - ../journal.ts         - `HarnessJournal`, which the worker instantiates verbatim
//   - ../sessions.ts:1945   - `persistOrThrow` (strict) and :2012 `noteStateChange`
//                             (synchronous observer -> coalescable enqueue)

// Bumped whenever a frame changes incompatibly. The client refuses a `hello` whose
// version differs, so a stale `dist/` worker bundle against a fresh coordinator fails
// at startup with a readable reason instead of mis-parsing receipts.
export const IO_PROTOCOL_VERSION = 1;

// Handshake marker: `io-worker.ts` starts its message loop ONLY when spawned by this
// client (workerData carries the protocol version). Without the guard, importing the
// module from a test that happens to run inside a worker thread would attach a
// listener to that thread's own port.
export const IO_WORKER_BOOT_KEY = 'harnessIoWorker';

// Bounded wait for `hello`. A worker that never answers is a FAILURE (a deployment
// that asked for offloaded persistence and did not get it), never an inline fallback.
export const IO_HANDSHAKE_MS = 60_000;

// Upper bound on one frame's serialized size. Unlike a lane frame (a tool result is
// capped at 64 KiB by the core), a checkpoint frame is the WHOLE document, so the
// bound is generous: it exists to fail a runaway document before it costs a second
// process a write, not to shape normal traffic. The worker checks the exact byte
// length after serialization; the client pre-checks with its last measured document
// size so a permanently oversized database does not keep paying the clone.
export const IO_MAX_FRAME_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Targets (data only)
// ---------------------------------------------------------------------------

// The checkpoint file, exactly as `HarnessPersistence` names it (../persistence.ts).
// Sent as both halves rather than derived in the worker so a worker cannot silently
// write somewhere the coordinator never reads.
export type IoCheckpointTarget = {
    directory: string;
    file: string;
};

// One session's journal. The worker builds `new HarnessJournal(root, sessionId)` with
// the SAME pair ../sessions.ts:3315 uses, so the on-disk layout is shared code.
export type IoJournalTarget = {
    root: string;
    sessionId: string;
};

// One journal line's data. `event` is a `HarnessEvent` narrowed to `unknown` here so
// the worker's type surface stays free of the harness runtime (and its bundle stays
// fs-only); ../journal.ts validates what a reader accepts.
export type IoJournalRecord = {
    turnId: string;
    index: number;
    at: number;
    event: unknown;
};

// A durable compaction payload: the event records to keep. `JournalEventRecord`
// without the `type`/`v` stamps, which the writer adds (../journal.ts:402).
export type IoJournalRewriteRecord = {
    turnId: string;
    index: number;
    at: number;
    event: unknown;
};

// ---------------------------------------------------------------------------
// Outcomes and errors
// ---------------------------------------------------------------------------

// See the module header: these three are NOT interchangeable, and a caller that needs
// durability fences on 'durable'.
//
// The split matters for the type surface: a WORKER may answer only 'durable' or
// 'written' - 'superseded' is a coordinator-side notion (a queued checkpoint replaced
// by a newer document before it was ever posted), so it is not part of a reply at all.
export type IoWorkerOutcome = 'durable' | 'written';

export type IoOperationOutcome = IoWorkerOutcome | 'superseded';

// A flattened failure. `message` is the exact text the synchronous writer would have
// thrown, so `SessionError(500, 'Could not save the harness database: ...')` (the
// store's mapping at ../sessions.ts:1957) reads identically in both modes.
export type IoErrorReport = {
    message: string;
    // The most specific identifier available: a raw errno (`ENOENT`, `EPERM`, ...) when
    // the failure carries one, otherwise one of 'journal' (a journal refusal, reported
    // with the same text `HarnessJournal.error` holds), 'frame-too-large', 'fs', or
    // 'io-exception'.
    code: string;
    path?: string;
    // The raw failure behind a WRAPPED message. A checkpoint failure reaches the worker
    // as `HarnessPersistenceError("<file>: Could not write the harness database:
    // <errno>")`, and the inline writer's own `lastWriteError` channel carries just the
    // `<errno>` (../persistence.ts, `causeOf`). Carrying both keeps the two modes
    // identical on BOTH surfaces: `message` for a thrown error, `cause` for the sticky
    // error getter.
    cause?: string;
};

// ---------------------------------------------------------------------------
// Coordinator -> worker
// ---------------------------------------------------------------------------

// The closed set of operations. A union, not a string map, so a typo is a compile
// error at the call site instead of a frame nobody answers.
export type IoOperationKind =
    | 'checkpoint.save'
    | 'journal.open'
    | 'journal.append'
    | 'journal.flush'
    | 'journal.rewrite'
    | 'journal.truncate'
    | 'journal.remove'
    | 'journal.close';

export const IO_OPERATION_KINDS: readonly IoOperationKind[] = [
    'checkpoint.save',
    'journal.open',
    'journal.append',
    'journal.flush',
    'journal.rewrite',
    'journal.truncate',
    'journal.remove',
    'journal.close'
];

// Which outcome each operation answers with. Exported because the CLIENT asserts it (a
// 'written' answer to a save would be a protocol bug worth naming) and because it is the
// durable/not-durable table a reviewer checks against R4.
export const IO_DURABLE_OUTCOMES: Record<IoOperationKind, IoWorkerOutcome> = {
    'checkpoint.save': 'durable',
    'journal.open': 'written',
    'journal.append': 'written',
    'journal.flush': 'durable',
    'journal.rewrite': 'durable',
    'journal.truncate': 'durable',
    'journal.remove': 'durable',
    'journal.close': 'durable'
};

export type IoOperation =
    // Full-document checkpoint: serialize + atomic replace. Answers 'durable'. The
    // target travels with the frame (two short strings) so the worker stays stateless
    // about WHERE it writes: it can never write somewhere the coordinator does not
    // read, and one worker could in principle serve two roots.
    | { kind: 'checkpoint.save'; callId: number; target: IoCheckpointTarget; document: unknown; savedAt: number }
    // Create the directory and write the header line once (../journal.ts:234).
    | { kind: 'journal.open'; callId: number; target: IoJournalTarget }
    // One event line, to the held append handle. Answers 'written'.
    | { kind: 'journal.append'; callId: number; target: IoJournalTarget; record: IoJournalRecord }
    // fsync the append handle: every append posted before this frame is durable.
    | { kind: 'journal.flush'; callId: number; target: IoJournalTarget }
    // Atomic compaction (tmp + fsync + rename) with a fresh header.
    | { kind: 'journal.rewrite'; callId: number; target: IoJournalTarget; records: IoJournalRewriteRecord[] }
    // Drop every recorded event (a reset): rewrite with no records.
    | { kind: 'journal.truncate'; callId: number; target: IoJournalTarget }
    // Remove the session's whole journal directory (a session delete).
    | { kind: 'journal.remove'; callId: number; target: IoJournalTarget }
    // fsync + close the append handle; the log itself stays on disk (a dispose).
    | { kind: 'journal.close'; callId: number; target: IoJournalTarget };

export type IoCommand =
    // First frame. Answers `hello` with the worker's protocol version.
    | { kind: 'hello'; callId: 0 }
    // Drain, then let the process exit. Answers `bye` when the queue it received is
    // empty; the client terminates the worker itself if the worker outlives the drain.
    | { kind: 'shutdown'; callId: number; reason?: string }
    // Any operation.
    | IoOperation;

// ---------------------------------------------------------------------------
// Worker -> coordinator
// ---------------------------------------------------------------------------

export type IoReply =
    // Handshake result. `version` MUST equal `IO_PROTOCOL_VERSION` or the client quits.
    | { kind: 'hello'; callId: 0; version: number; ok: true }
    // `shutdown` acknowledged: nothing is outstanding in the worker.
    | { kind: 'bye'; callId: number; ok: true; drained: number }
    // One operation finished successfully. `bytes` is the exact serialized length the
    // worker wrote (the client feeds it back into its own frame-size estimate, which
    // keeps that check O(1) instead of another stringify on the main thread).
    | {
          kind: 'result';
          callId: number;
          ok: true;
          outcome: IoWorkerOutcome;
          durationMs: number;
          bytes?: number;
      }
    // One operation failed. The queue keeps running: a full disk must not wedge the
    // store, exactly as the inline best-effort path keeps running. `bytes` is carried on
    // a refusal that MEASURED the payload (the size guard), so the client can stop
    // cloning a database that is permanently oversized even though nothing was written.
    | { kind: 'failure'; callId: number; ok: false; error: IoErrorReport; durationMs: number; bytes?: number }
    // A worker-side fault that is not an operation failure: an unknown frame, a
    // protocol violation, or a lost realm.
    | { kind: 'fault'; callId?: number; message: string };

export type IoEnvelope = IoCommand | IoReply;

// Named views of the reply union, for a caller (or a test) that wants to talk about one
// answer shape without re-stating it.
export type IoResult = Extract<IoReply, { kind: 'result' }>;
export type IoFailure = Extract<IoReply, { kind: 'failure' }>;
export type IoFault = Extract<IoReply, { kind: 'fault' }>;

const REPLY_KINDS = new Set(['hello', 'bye', 'result', 'failure', 'fault']);

// Structural validation of a command, at the WORKER boundary. Cheap and total: kind,
// integer callId, and the shape of the fields the dispatcher indexes into.
export const isIoCommand = (value: unknown): value is IoCommand => {
    if (typeof value !== 'object' || value === null) return false;

    const candidate = value as { kind?: unknown; callId?: unknown };

    if (typeof candidate.kind !== 'string') return false;

    if (candidate.kind === 'hello') return candidate.callId === 0;
    if (candidate.kind === 'shutdown') return isIoCallId(candidate.callId);

    if (!IO_OPERATION_KINDS.includes(candidate.kind as IoOperationKind)) return false;
    if (!isIoCallId(candidate.callId)) return false;

    return isIoOperationShape(candidate as Record<string, unknown>, candidate.kind as IoOperationKind);
};

// Structural validation of a reply, at the CLIENT boundary.
export const isIoReply = (value: unknown): value is IoReply => {
    if (typeof value !== 'object' || value === null) return false;

    const candidate = value as { kind?: unknown; callId?: unknown; ok?: unknown; message?: unknown };

    if (typeof candidate.kind !== 'string' || !REPLY_KINDS.has(candidate.kind)) return false;

    if (candidate.kind === 'fault') {
        return (
            (candidate.callId === undefined || isIoCallId(candidate.callId)) &&
            typeof candidate.message === 'string'
        );
    }

    if (candidate.kind === 'fault') {
        return (
            (candidate.callId === undefined || isIoCallId(candidate.callId)) &&
            typeof candidate.message === 'string'
        );
    }

    if (candidate.kind === 'failure') {
        // A failure carries `ok: false` by definition, so it is checked before the
        // `ok === true` gate that the three success answers share.
        const error = (value as { error?: unknown }).error;

        return (
            candidate.ok === false &&
            isIoCallId(candidate.callId) &&
            typeof error === 'object' &&
            error !== null &&
            typeof (error as { message?: unknown }).message === 'string' &&
            typeof (error as { code?: unknown }).code === 'string'
        );
    }

    if (candidate.ok !== true) return false;

    if (candidate.kind === 'hello') return candidate.callId === 0 && typeof (value as { version?: unknown }).version === 'number';
    if (candidate.kind === 'bye') return isIoCallId(candidate.callId);

    if (candidate.kind === 'result') {
        const outcome = (value as { outcome?: unknown }).outcome;

        // 'superseded' is not a legal worker answer (see IoWorkerOutcome): accepting
        // only the two real outcomes turns a confused bundle into a named rejection
        // instead of a receipt whose meaning the client would have to guess.
        return (
            isIoCallId(candidate.callId) &&
            (outcome === 'durable' || outcome === 'written') &&
            typeof (value as { durationMs?: unknown }).durationMs === 'number'
        );
    }

    return false;
};

const isIoCallId = (value: unknown): boolean =>
    typeof value === 'number' && Number.isInteger(value) && value > 0;

// The callId to attribute a FAULT to, when the frame carrying it failed validation.
//
// A fault that names no operation cannot be routed, so the operation waiting on it would
// never settle and the request would hang. A rejected frame still usually carries a
// usable callId, and reporting it is the difference between "this write failed" and "the
// server is mysteriously stuck".
export const ioFaultCallId = (value: unknown): number | undefined => {
    if (typeof value !== 'object' || value === null) return undefined;

    const callId = (value as { callId?: unknown }).callId;

    return isIoCallId(callId) ? (callId as number) : undefined;
};

// The per-kind field check. Split out so `isIoCommand` stays readable and each rule is
// individually assertable.
const isIoOperationShape = (frame: Record<string, unknown>, kind: IoOperationKind): boolean => {
    if (kind === 'checkpoint.save') {
        return (
            isIoCheckpointTarget(frame.target) &&
            // The document travels as data; `savedAt` is stamped by the COORDINATOR, so
            // a checkpoint's timestamp is when the mutation happened, not when the
            // worker got around to writing it.
            typeof frame.savedAt === 'number' &&
            Number.isFinite(frame.savedAt) &&
            typeof frame.document === 'object' &&
            frame.document !== null
        );
    }

    // Every journal kind addresses one session's log.
    if (!isIoJournalTarget(frame.target)) return false;

    if (kind === 'journal.append') return isIoJournalRecord(frame.record);
    if (kind === 'journal.rewrite') return Array.isArray(frame.records);

    return true;
};

export const isIoJournalTarget = (value: unknown): value is IoJournalTarget => {
    if (typeof value !== 'object' || value === null) return false;

    const candidate = value as { root?: unknown; sessionId?: unknown };

    return typeof candidate.root === 'string' && candidate.root.length > 0 && typeof candidate.sessionId === 'string' && candidate.sessionId.length > 0;
};

export const isIoCheckpointTarget = (value: unknown): value is IoCheckpointTarget => {
    if (typeof value !== 'object' || value === null) return false;

    const candidate = value as { directory?: unknown; file?: unknown };

    return typeof candidate.directory === 'string' && candidate.directory.length > 0 && typeof candidate.file === 'string' && candidate.file.length > 0;
};

export const isIoJournalRecord = (value: unknown): value is IoJournalRecord => {
    if (typeof value !== 'object' || value === null) return false;

    const candidate = value as { turnId?: unknown; index?: unknown; at?: unknown; event?: unknown };

    if (typeof candidate.turnId !== 'string' || candidate.turnId.length === 0) return false;
    if (typeof candidate.index !== 'number' || !Number.isInteger(candidate.index) || candidate.index < 0) return false;
    if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) return false;

    // A non-object event would fold into the projector as a phantom step
    // (../journal.ts:170 enforces the same rule on the read side).
    return typeof candidate.event === 'object' && candidate.event !== null;
};

// Stable Map key for one journal handle. `\u0000` cannot appear in a session id
// (uuid), so the pair is unambiguous.
export const ioJournalKey = (target: IoJournalTarget): string => `${target.root}\u0000${target.sessionId}`;

// The human-readable offender for a rejected frame. Never echoes a payload: a
// checkpoint frame is the entire database.
export const describeIoFrame = (value: unknown): string => {
    if (typeof value !== 'object' || value === null) return typeof value;

    const candidate = value as { kind?: unknown; callId?: unknown };

    return `kind=${JSON.stringify(candidate.kind)} callId=${JSON.stringify(candidate.callId)}`;
};

// A frame must survive `postMessage`. Not checked per frame on purpose: a
// structuredClone costs the same as the clone `postMessage` is about to perform, so a
// pre-flight check would double the one main-thread cost this design is trying to
// reduce. Instead the client wraps every `postMessage` and turns a DataCloneError into a
// named failure of that operation (./io-client.ts, `not-cloneable`).
export const isTransferableIoFrame = (value: unknown): boolean => {
    try {
        structuredClone(value);

        return true;
    } catch {
        return false;
    }
};

// Monotonic call id source: starts at 1 so `0` unambiguously means "not an operation"
// (the hello frame reuses 0).
export const createIoCallIds = (): (() => number) => {
    let current = 0;

    return () => {
        current += 1;

        return current;
    };
};

// The failure report for a thrown error.
//
// The MESSAGE stays the thrown error's own text: a checkpoint failure reaches the
// caller as `HarnessPersistenceError("<file>: Could not write the harness database:
// <errno>")`, and that is the string the inline path puts in a 500, so the two modes
// must read alike. The CODE reaches through the wrapper's `cause` when it has one, so
// an errno (`ENOENT`, `EPERM`, ...) survives for a caller that branches on it, and
// `path` likewise prefers the raw failure's `file`.
export const ioErrorReportOf = (error: unknown, fallbackCode = 'io-exception'): IoErrorReport => {
    const message = error instanceof Error ? error.message : String(error);
    const cause = (error as { cause?: unknown } | undefined)?.cause;

    const codeOf = (value: unknown): string | undefined => {
        const code = (value as { code?: unknown } | undefined)?.code;

        return typeof code === 'string' ? code : undefined;
    };

    const pathOf = (value: unknown): string | undefined => {
        const file = (value as { file?: unknown } | undefined)?.file;

        return typeof file === 'string' ? file : undefined;
    };

    const causeMessage = cause instanceof Error ? cause.message : undefined;

    return {
        message,
        code: codeOf(error) ?? codeOf(cause) ?? fallbackCode,
        ...(pathOf(error) !== undefined ? { path: pathOf(error) } : pathOf(cause) !== undefined ? { path: pathOf(cause) } : {}),
        // Only when it is genuinely a different string: a journal failure has no
        // wrapper, and repeating the message as a `cause` would invite a caller to
        // think the two surfaces differ when they do not.
        ...(causeMessage !== undefined && causeMessage !== message ? { cause: causeMessage } : {})
    };
};

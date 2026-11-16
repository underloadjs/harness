// IO-worker wire protocol (R1/R2/R4/R5): the data-only frames the session coordinator
// and the ONE persistence/journal worker exchange.
//
// R5 CHANGED WHAT TRAVELS, NOT WHAT THE CONTRACT SAYS
// ---------------------------------------------------
// A commit used to be ONE `checkpoint.save` frame carrying the whole `HarnessDatabase`
// document, which the worker serialized into one `state.json`. With hundreds of sessions
// and thousands of threads per database, one file is the wrong unit of storage, so a
// commit is now a SEQUENCE of `shard.save` frames - one per shard file:
//   <dir>/index.json, <dir>/sessions/<id>/session.json, <dir>/sessions/<id>/threads/<tid>.json
// Every rule below (one FIFO queue, synchronous operations, the three named outcomes, no
// reads on the worker, the size bound enforced before a syscall) is the SAME rule, applied
// per shard instead of per document. Nothing in the durability contract was relaxed to
// make the change; only the payload got smaller.
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
//     checkpoint-must-not-overtake-the-journal rule from ../journal.ts:44-46 holds by
//     construction instead of by caller discipline. Under R5 "the document" is the
//     session's `session.json` (and every commit's `index.json` follows it), so the fence
//     still lands on the file that lists the event - it is just no longer the only file.
//   - A `callId` names every reply. Nothing is matched by arrival order on the way
//     back either, so a late reply from a superseded client is still attributed
//     correctly (and dropped with a reason if its op was already settled).
//   - SHARD ORDER (R5): one commit's units are posted in the order `IO_SHARD_ORDER`
//     gives them - every thread shard, then that session's `session.json`, then
//     `index.json` - and the queue is FIFO, so the leaf files are on disk before the
//     file that references them, and no commit is ever half-published by a crash in an
//     arbitrary order. A reader that starts from `index.json` therefore never follows a
//     reference to a shard that was written after it. `orderIoShardUnits` is the single
//     place that spells the order, so client and reviewer read the same rule.
//
// DURABILITY CONTRACT (no fire-and-forget claims)
// -----------------------------------------------
// A result names its outcome explicitly, and the three outcomes mean different things:
//   - 'durable'   - the operation reached its durability boundary (shard: fsynced staging
//                   + rename; journal flush: fsync; rewrite: fsync + rename).
//   - 'written'   - the bytes were handed to the OS through a held fd (append), i.e.
//                   safe across a PROCESS crash and exactly as strong as the inline
//                   writer has always been, but NOT fenced against a power loss until
//                   a 'durable' flush names them. A caller must not read this as a
//                   durability claim.
//   - 'superseded'- resolved by the COORDINATOR without a round trip: a newer
//                   best-effort SHARD replaced this one for the same path in the queue, so
//                   this exact payload was never written. Honest, not silent: the caller
//                   that asked for a barrier still fences on the newer shard.
// A failed operation answers `ok: false` with the message the synchronous path would
// have thrown. Nothing answers `ok: true` for a document that is not durable, and a
// worker that dies answers NOTHING - the client fails every outstanding operation.
//
// NO COMPOSITE CLAIM (R5): a commit is several `shard.save` frames, and each one answers
// for ITSELF. The receipt list names every shard and its own outcome; nothing in the
// protocol claims "all shards durable" from the index shard's receipt, because the
// rename of `index.json` does not fsync the thread file that precedes it. A caller that
// needs the whole commit durable awaits every receipt, which is what `saveCheckpoint`
// and `commitCheckpoint` do before they resolve.
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
//   - No knowledge of the SHARD FORMAT in this file. A shard payload is A1's
//     `HarnessShardUnit` and travels as data; the protocol only ever reads
//     `unit.kind`, which is the field the ordering rule and the refusal message need.
//     Serializing and committing a unit is `serializeHarnessShard` /
//     `writeHarnessShardFile` (../persistence.ts), shared with the inline writer so the
//     two modes cannot drift.
//
// Cross-references:
//   - ./io-worker.ts        - the worker side: the dispatcher and its self-start guard
//   - ./io-client.ts        - the coordinator side: FIFO queue, per-path coalescing, barrier
//   - ./io-worker-loop.ts   - the per-shard commit + the exact-size guard
//   - ../persistence.ts     - `serializeHarnessShard` / `writeHarnessShardFile`, and the
//                             `HarnessShardUnit` union (`index` | `session` | `thread`)
//   - ../journal.ts         - `HarnessJournal`, which the worker instantiates verbatim
//   - ../sessions.ts:3555   - `persistOrThrow` (strict) and :3629 `persistBestEffort`
//                             (synchronous observer -> coalescable enqueue)

// Bumped whenever a frame changes incompatibly. The client refuses a `hello` whose
// version differs, so a stale `dist/` worker bundle against a fresh coordinator fails
// at startup with a readable reason instead of mis-parsing receipts.
//
// 2 (R5): `checkpoint.save` (one whole-document frame per commit) became `shard.save`
// (one frame per shard file). The change is not addable: a version-1 worker would receive
// frames it has no operation for, and a version-2 worker would never see the whole
// document a version-1 client sends. Both fail at the handshake, which is the point.
//
// 3 (worker-mode parity): the operation set grew `shard.erase`, the removal of the shards a
// document no longer names (a dropped session's `session.json` and `threads/` tree, a
// transcript retired by the record cap). NOT addable, in the same sense as v2 above: a
// version-2 worker has no handler for the kind, so it would answer a `fault` and the erased
// files would stay — precisely the orphan accumulation the kind exists to stop, and a client
// that believes its removals are queued would be wrong. The `skipped` flag on a `result` IS
// additive (an old client ignores it and simply counts the bytes again), so it is not the
// reason for the bump.
//
// REMEMBER: the packed-package smoke (scripts/check-package-runtime.ts) mirrors this constant
// and the boot marker by hand, so a bump is a two-file change until that script derives it.
export const IO_PROTOCOL_VERSION = 3;

// Handshake marker: `io-worker.ts` starts its message loop ONLY when spawned by this
// client (workerData carries the protocol version). Without the guard, importing the
// module from a test that happens to run inside a worker thread would attach a
// listener to that thread's own port.
export const IO_WORKER_BOOT_KEY = 'harnessIoWorker';

// Bounded wait for `hello`. A worker that never answers is a FAILURE (a deployment
// that asked for offloaded persistence and did not get it), never an inline fallback.
export const IO_HANDSHAKE_MS = 60_000;

// Upper bound on one frame's serialized size. R5 moved the bound from "one document" to
// "one shard", which is the point of the split: a 110 MB database made every save a 110 MB
// frame, while one conversation's transcript or one thread is orders of magnitude smaller,
// so the same number now refuses a runaway shard instead of describing the whole store.
// The bound stays generous on purpose: it exists to fail a runaway payload before it costs
// a second process a write, not to shape normal traffic. The worker checks the exact byte
// length after serialization; the client pre-checks with its last MEASURED size for that
// same path (./io-client.ts `stats.lastShardBytes`), so a permanently oversized shard stops paying
// the clone - per path, so one oversized conversation cannot freeze every other write.
export const IO_MAX_FRAME_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Targets (data only)
// ---------------------------------------------------------------------------

// The database this client commits to, spelled the way `HarnessPersistence` spells it
// (../persistence.ts): the directory, and the file the store LOADS first. Under R5 that
// file is `index.json` (A1's `HARNESS_INDEX_FILE`); the shape is unchanged on purpose, so
// the integration stays literally `createHarnessIoClient({ persistence: this.persistence })`
// and the index shard's target is derived from what the store already owns.
export type IoCheckpointTarget = {
    directory: string;
    file: string;
};

// The three shard files R5 introduced. These names are NOT free: they must match
// `HarnessShardUnit['kind']` (../persistence.ts), because `kind` is the ONE field this
// layer reads off a unit - it is what the ordering rule and the refusal message key on.
export type IoShardKind = 'index' | 'session' | 'thread';

export const IO_SHARD_KINDS: readonly IoShardKind[] = ['index', 'session', 'thread'];

// THE commit order (R5): every thread shard, then that session's `session.json`, then
// `index.json`. A smaller number is posted first.
//
// WHY THIS ORDER AND NO OTHER
// ---------------------------
// The reader starts at `index.json` and follows references down, so a file that is
// REFERENCED must exist before the file that references it is published. Each shard is
// committed by its own atomic rename, so an interrupted commit can stop anywhere - but it
// can only ever stop at a point where everything the already-published files reference is
// already on disk. `IO_MAX_FRAME_BYTES`-refused middle units are the one way a commit is
// partial, and that is reported per unit, never folded into a composite claim.
//
// Array order is the rule; the record is a lookup of the same rule. Both are exported so
// a reviewer (and ./io-protocol.test.ts) can check the table instead of inferring it from
// a sort call site.
export const IO_SHARD_ORDER: Record<IoShardKind, number> = { thread: 0, session: 1, index: 2 };

// One shard file: WHERE it goes, spelled in the two halves the atomic commit needs (the
// staging file is created in `directory` and renamed to `file`, so a cross-directory
// rename would not be atomic - ../persistence.ts, `writeHarnessDatabaseFile`).
//
// `kind` travels with the path for two honest reasons: the worker's size refusal has to
// name WHICH file it refused, and the client keys its per-path coalescing and per-path
// byte accounting on this object rather than on A1's unit internals - so a change to the
// unit's field names cannot silently change which writes supersede each other.
export type IoShardTarget = {
    kind: IoShardKind;
    directory: string;
    file: string;
};

// One session's journal. The worker builds `new HarnessJournal(root, sessionId)` with
// the SAME pair ../sessions.ts:5588 uses, so the on-disk layout is shared code.
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
// without the `type`/`v` stamps, which the writer adds (../journal.ts:463).
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
// 'written' - 'superseded' is a coordinator-side notion (a queued SHARD replaced by a
// newer payload for the same path before it was ever posted), so it is not part of a
// reply at all.
export type IoWorkerOutcome = 'durable' | 'written';

export type IoOperationOutcome = IoWorkerOutcome | 'superseded';

// A flattened failure. `message` is the exact text the synchronous writer would have
// thrown, so `SessionError(500, 'Could not save the harness database: ...')` (the
// store's mapping at ../sessions.ts:3610) reads identically in both modes.
export type IoErrorReport = {
    message: string;
    // The most specific identifier available: a raw errno (`ENOENT`, `EPERM`, ...) when
    // the failure carries one, otherwise one of 'journal' (a journal refusal, reported
    // with the same text `HarnessJournal.error` holds), 'frame-too-large', 'shard-layout'
    // (the frame's target disagrees with `harnessShardFileOf(unit)` - client and worker
    // built from different layouts), 'shard-erase' (a shard the header stopped naming
    // could not be removed - reported, never fatal, because the leftover costs disk and
    // not correctness), 'fs', or 'io-exception'.
    code: string;
    // R5: the size refusal measures ONE shard and the writer fails on ONE file, so `path`
    // names that shard file. "The harness database" is no longer a single subject a
    // refusal can honestly point at - a commit is now several files.
    path?: string;
    // The raw failure behind a WRAPPED message. A shard failure reaches the worker
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
//
// `checkpoint.save` (R1-R4) is GONE rather than kept alongside: under R5 the store has no
// whole-document file to save, and a second checkpoint path that still wrote one document
// would be a second, contradicting storage layout in the same database directory.
export type IoOperationKind =
    | 'shard.save'
    // The removal side of the SAME storage story: the shards the new document no longer names.
    // Inline `save()` performs them inside the commit (`eraseVanishedShards`,
    // ../persistence.ts:3025); in worker mode the coordinator cannot do it itself without racing
    // the worker's queued writes for that session, so it goes through this queue like every other
    // byte the two modes agree on.
    | 'shard.erase'
    | 'journal.open'
    | 'journal.append'
    | 'journal.flush'
    | 'journal.rewrite'
    | 'journal.truncate'
    | 'journal.remove'
    | 'journal.close';

export const IO_OPERATION_KINDS: readonly IoOperationKind[] = [
    'shard.save',
    'shard.erase',
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
    'shard.save': 'durable',
    // 'durable' for a removal means exactly what it means for a save, read the other way: the
    // directory ENTRY is gone (an `rm`, which like the commit's rename is not itself fsynced —
    // the same boundary ../persistence.ts `commitHarnessFile` states). It is NOT a claim that
    // nothing else in the directory is left behind: a vanished session keeps its directory and
    // its `events.jsonl`, which is inline's outcome too.
    'shard.erase': 'durable',
    'journal.open': 'written',
    'journal.append': 'written',
    'journal.flush': 'durable',
    'journal.rewrite': 'durable',
    'journal.truncate': 'durable',
    'journal.remove': 'durable',
    'journal.close': 'durable'
};

export type IoOperation =
    // One SHARD, committed: serialize that unit + atomic replace of its own file. Answers
    // 'durable' for that file only.
    //
    // The target travels with the frame (kind + directory + file) so the worker stays
    // stateless about WHERE it writes: it can never write somewhere the coordinator does
    // not read, and one worker could in principle serve two roots. The `unit` is A1's
    // `HarnessShardUnit` and is otherwise opaque here - this layer reads `unit.kind` for
    // the ordering assertion and hands the whole unit to `writeHarnessShardFile`, so the
    // shard format stays defined in exactly one file (../persistence.ts).
    //
    // `savedAt` is stamped by the COORDINATOR, exactly as the whole-document checkpoint
    // always stamped it: it is the instant this payload became true, not the instant the
    // worker got around to writing it. One commit stamps once, so a session's threads, its
    // `session.json` and `index.json` cannot disagree about which state they describe.
    | { kind: 'shard.save'; callId: number; target: IoShardTarget; unit: unknown; savedAt: number }
    // The shards one commit no longer names, REMOVED. `files` are single shard files and
    // `trees` are directories whose whole content goes - exact paths the COORDINATOR derived
    // with A1's own layout primitives, because this layer owns no layout knowledge (the same
    // rule that keeps `unit` opaque). `target` names what the removal is ABOUT, so a refusal
    // can name a file the way a `shard.save` refusal names one.
    //
    // WHY A FRAME AT ALL: inline `save()` erases these itself, LAST, after the index is
    // durable (../persistence.ts `eraseVanishedShards`). A worker-mode coordinator that did the
    // same on its own thread could delete files the worker has not written YET (the queued
    // per-path coalescing means a session's shard can still be pending), and the worker's commit
    // does `mkdirSync` + rename - it would resurrect the orphan. Posted through the queue it is
    // ordered after that session's writes by construction, exactly like the inline order is.
    //
    // Durability is deliberately NO STRONGER than inline: an erase failure answers `failure`,
    // and the client never awaits the frame (inline swallows the failure too - the committed
    // state is correct whatever a leftover byte does, because `index.json` is authoritative).
    // A strict commit therefore makes no claim about removals at all.
    | { kind: 'shard.erase'; callId: number; target: IoShardTarget; files: readonly string[]; trees: readonly string[] }
    // Create the directory and write the header line once (../journal.ts:279-288).
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
    // worker wrote for THAT unit (the client feeds it back into its own per-path size
    // estimate, ./io-client.ts `stats.lastShardBytes`, which keeps the pre-check O(1)
    // instead of another stringify on the main thread).
    //
    // `skipped` says the worker found the bytes it was handed ALREADY on disk and wrote
    // NOTHING. It is an additive flag, not a new outcome: the file is durable either way,
    // so no caller branches on it and no durability meaning changes. The client uses it for
    // one thing, its `stats.skippedShards` report; a worker that never sets it (an older
    // peer) simply reports no skips.
    | {
          kind: 'result';
          callId: number;
          ok: true;
          outcome: IoWorkerOutcome;
          durationMs: number;
          bytes?: number;
          skipped?: boolean;
      }
    // One operation failed. The queue keeps running: a full disk must not wedge the
    // store, exactly as the inline best-effort path keeps running. `bytes` is carried on
    // a refusal that MEASURED the payload (the size guard), so the client can stop
    // cloning a permanently oversized SHARD even though nothing was written - and, because
    // the accounting is per path, it stops cloning THAT shard only: every other shard of
    // the same commit still commits (R5).
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
    if (kind === 'shard.save') {
        return (
            isIoShardTarget(frame.target) &&
            // `savedAt` is stamped by the COORDINATOR (when the payload became true), and
            // one commit stamps once, so a session's thread shards and its `session.json`
            // cannot claim different instants of the same mutation.
            typeof frame.savedAt === 'number' &&
            Number.isFinite(frame.savedAt) &&
            // The unit travels as data. The ONLY field this layer reads is its `kind`, and
            // it reads it to prove the frame is self-consistent: a unit whose own kind
            // disagrees with the target it was given would let a thread payload be renamed
            // over `index.json` and nothing downstream could tell.
            isIoShardUnit(frame.unit) &&
            (frame.unit as { kind?: unknown }).kind === (frame.target as IoShardTarget).kind
        );
    }

    // A removal names the shards to erase, and the paths are ABSOLUTE files/directories the
    // coordinator derived from the layout — this layer still names no file itself, exactly as
    // for `shard.save`. At least one entry must be present: a frame that erases nothing is a
    // coordinator bug, and answering `durable` for no work would hide it.
    if (kind === 'shard.erase') {
        const files = frame.files;
        const trees = frame.trees;

        return (
            isIoShardTarget(frame.target) &&
            Array.isArray(files) &&
            Array.isArray(trees) &&
            (files as readonly unknown[]).length + (trees as readonly unknown[]).length > 0 &&
            (files as readonly unknown[]).every((entry) => typeof entry === 'string' && entry.length > 0) &&
            (trees as readonly unknown[]).every((entry) => typeof entry === 'string' && entry.length > 0)
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

export const isIoShardTarget = (value: unknown): value is IoShardTarget => {
    if (!isIoCheckpointTarget(value)) return false;

    const kind = (value as { kind?: unknown }).kind;

    // The kind is part of the target (not just of the unit) precisely so a frame can be
    // refused at the boundary instead of committing a thread payload under a name the
    // reader will later try to parse as an index.
    return IO_SHARD_KINDS.includes(kind as IoShardKind);
};

// A shard unit is A1's discriminated union; this layer only ever needs to know that it IS
// one, so the check is the discriminator and nothing else. Deliberately shallow: a deeper
// check would duplicate the persistence layer's format knowledge into the wire protocol.
export const isIoShardUnit = (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null) return false;

    return IO_SHARD_KINDS.includes((value as { kind?: unknown }).kind as IoShardKind);
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

// THE key for one shard (R5): its canonical file. The file is unique per shard by layout
// (one index, one `session.json` per session, one file per thread), so no composite key is
// needed - and using the file itself is what makes coalescing provably per-DESTINATION:
// two units supersede each other exactly when they would have overwritten each other.
export const ioShardPath = (target: IoShardTarget): string => target.file;

// Puts one commit's units into the order the disk must see them: threads, then the session
// files that reference them, then the index that references those (`IO_SHARD_ORDER`).
//
// The sort is STABLE, so units of the same kind keep the order the caller built them in -
// which matters because "the order the caller called in is the order the disk sees" is the
// rule the whole queue rests on. No unit is ever reordered across kinds beyond this rule,
// and no unit is dropped: the caller's list is exactly the worker's list.
export const orderIoShardUnits = <T extends { target: IoShardTarget }>(units: readonly T[]): T[] =>
    [...units].sort((left, right) => IO_SHARD_ORDER[left.target.kind] - IO_SHARD_ORDER[right.target.kind]);

// The human-readable offender for a rejected frame. Never echoes a payload: a shard frame
// carries one conversation's transcript or one thread, and quoting it would put user
// content in an operator's error.
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
// The MESSAGE stays the thrown error's own text: a shard failure reaches the caller as
// `HarnessPersistenceError("<file>: Could not write the harness database: <errno>")`,
// and that is the string the inline path puts in a 500, so the two modes must read alike. The CODE reaches through the wrapper's `cause` when it has one, so
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

// The coordinator side of worker IO (R1/R2/R4/R5): one FIFO durability queue per
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
//      a journal append reaches the file before the shard that lists it, and a
//      `journal.flush` enqueued before a save fences those events (fsync) before the
//      session's `session.json` is renamed into place - the rule ../journal.ts has always
//      relied on ("a journal line is written BEFORE the document is rewritten"). The
//      client therefore never posts a frame while a deferred shard is pending without
//      dealing with that shard first, which keeps "the order the caller called in" equal
//      to "the order the disk sees". WITHIN one commit, `orderIoShardUnits` puts every
//      thread shard before the `session.json` that references it and every session file
//      before the `index.json` that references those (R5) - still one FIFO enqueue, so the
//      queue is what enforces it, not caller discipline.
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
//   - the split and the structured clone `postMessage` performs on each frame: EVERY
//     checkpoint re-fans the WHOLE document into units (`harnessShardUnitsOf`, :506) and posts
//     one frame per unit, strict (`commitShardEntries`) and queued (`shardCommitPlanOf` ->
//     `flushDeferred`) alike, so per-commit fan-out, clone and worker-side stringify are O(TOTAL
//     STORE) — not O(what changed) — while the coordinator owns the state. The split's win is the
//     WRITE SYSCALL and the FAILURE RADIUS: one changed shard costs one file's
//     mkdir/open/write/fsync/rename, and the worker's gate (`committedShards`,
//     ./io-worker-loop.ts:142, applied :355-367) leaves an unchanged shard UNOPENED.
//   - so a shard is bounded by `maxFrameBytes`: the client refuses to post a SHARD it
//     already MEASURED as oversized (`stats.lastShardBytes`, keyed by path - the worker's reply
//     carries the exact byte length, so the estimate costs nothing after the first
//     commit) and the worker re-checks the true length before touching the disk. One
//     runaway conversation fails loudly and stops being cloned WITHOUT freezing every
//     other shard, which is exactly what a single whole-document bound could not promise.
//
// COALESCING (why the best-effort path is cheaper here than inline ever was)
// ---------------------------------------------------------------------------
// `noteStateChange` (../sessions.ts:3782, which defers to `persistBestEffort` at :3629) is a SYNCHRONOUS core
// observer and `checkpoint()` is interval-throttled. Neither may block, and neither needs
// THIS document to be durable - they need "the newest state eventually".
// `queueCheckpointSave` therefore holds one pending SHARD PER PATH and posts them at the
// end of the current event-loop turn, replacing a queued shard as soon as another save
// for the SAME file is queued first. A replaced shard is counted as `superseded` - in
// total and per path, because "which files are being coalesced away" is the question an
// operator actually asks - and is reported as exactly that, never as durable. A strict
// save supersedes the pending shards for the paths it is about to write itself (same
// reasoning, one commit instead of two) and flushes first any pending shard for a path it
// is NOT writing, so ordering is never disturbed.
//
// THE SEMANTIC DIFFERENCE A REVIEWER MUST SEE (stated, not weakened):
//   - inline `persistence.save()` returns after the rename of the one document;
//   - worker `queueCheckpointSave()` returns after the shards are QUEUED, and the
//     renames happen later on the worker thread. A crash inside that window loses at
//     most mutations that were never durable anywhere anyway - but the window did not
//     exist inline. Anything that must be durable before a response uses
//     `saveCheckpoint()` / `commitCheckpoint()` and AWAITS them - which awaits EVERY
//     shard of the commit, not just the index. That is why the strict call sites become
//     async in worker mode, and it is the honest price of not blocking the loop.
//
// THE SHARD LAYOUT, AND WHO OWNS IT (read this before changing a path here)
// --------------------------------------------------------------------------
// A commit lays out exactly three kinds of file:
//   <dir>/index.json                              <- `persistence.file` (HARNESS_INDEX_FILE)
//   <dir>/sessions/<id>/session.json              <- HARNESS_SESSION_FILE
//   <dir>/sessions/<id>/threads/<threadId>.json   <- HARNESS_THREAD_DIRECTORY
// The session directory is the one `HarnessJournal` already uses (`HARNESS_JOURNAL_
// DIRECTORY`), so a session's journal and its shards sit in one directory and a session
// delete is one subtree.
//
// The UNIT PAYLOAD FORMAT is A1's (`HarnessShardUnit`, ../persistence.ts) and this file
// reads exactly THREE fields off a unit - `kind`, `directory`, `file` (see
// `shardTargetOf`) - because those are the three the queue needs for ordering, per-path
// coalescing and honest refusal messages. `harnessShardUnitsOf` is the default
// document->units split, kept in ONE exported function so the persistence layer can own it
// (and this file can delegate to it) without touching anything else here.
//
// Cross-references:
//   - ./io-protocol.ts  - the frames, the three outcomes ('durable' / 'written' /
//                         'superseded'), and the `IO_SHARD_ORDER` commit order
//   - ./io-worker.ts    - the thread that performs the writes
//   - ../persistence.ts - `HarnessShardUnit` + `serializeHarnessShard` /
//                         `writeHarnessShardFile` (the only shard knowledge this file is
//                         allowed: see `shardTargetOf` and `harnessShardUnitsOf`), and the
//                         shard file names a commit is laid out with
//   - ../journal.ts     - `HarnessJournal`, whose per-session error state this client
//                         reproduces so the store's reporter is unchanged
//   - ./io-worker.test.ts / ./io-client.test.ts - real worker execution: per-shard
//                         ordering, per-path supersession, barriers, error close, and
//                         byte-identity with the inline writer for the SAME set of units
//   - the integration contract the store owner implements is the block at the bottom of
//     this file

import fs from 'node:fs';
import { createRequire } from 'node:module';
// Needed for ONE thing: building a directory PREFIX for the deferred-slot drops below, where the
// separator has to be the platform's own (`sessions/<id>` is a prefix of `sessions/<id>-backup`,
// so a prefix check without the separator would drop a sibling session's queued writes).
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
// R5 made this client a CONSUMER of the shard layout, and it consumes it through A1's own
// exported primitives - never a re-spelled literal. Without this, two files could disagree
// about where `session.json` lives, and the disagreement would only surface as a reader
// that cannot find the files the writer wrote.
import { harnessIndexDocumentOf, harnessSessionDirectoryOf, harnessSessionFileOf, harnessShardFileOf, harnessThreadDirectoryOf, harnessThreadFileOf, splitHarnessSessionRecord } from '../persistence';
import type { HarnessDatabase, HarnessShardUnit } from '../persistence';
import {
    IO_HANDSHAKE_MS,
    IO_MAX_FRAME_BYTES,
    IO_PROTOCOL_VERSION,
    IO_WORKER_BOOT_KEY,
    createIoCallIds,
    ioShardPath,
    isIoReply,
    orderIoShardUnits,
    type IoCheckpointTarget,
    type IoCommand,
    type IoJournalRecord,
    type IoJournalRewriteRecord,
    type IoOperationKind,
    type IoReply,
    type IoShardTarget
} from './io-protocol';
import { openHarnessWorkerSession } from './worker-runner';

// The package subpath a consumer addresses the IO worker entry by. `resolveIoWorkerEntry`
// owns the lookup chain and the exact message an operator gets when it does not resolve.
// There is no `dist/` filename to emit: this package publishes TypeScript source, and the
// entry is loaded through the Vite module runner (./worker-boot.mjs), so the subpath target
// IS the production entry.
export const IO_WORKER_PACKAGE_SPECIFIER = '@underload/harness/io-worker';

// How a resolved entry got its path. Every entry is loaded the same way now - a `.ts`
// module through the shared Vite runner - so this records only HOW the path was chosen
// (operator override vs package resolution vs checkout layout), which is what an operator
// reading a `worker-entry-missing` message needs.
export type IoWorkerEntryMode = 'explicit' | 'env' | 'package' | 'source';

export type IoWorkerEntry = { path: string; mode: IoWorkerEntryMode };

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
        // (`../sessions.ts:3610`). Prepending the path again would double it - and a
        // journal failure's errno text already names the path it failed on. `path` stays
        // a property, the way `HarnessJournalError` keeps `file` (../journal.ts:147).
        super(message);
        this.name = 'HarnessIoError';
    }
}

// What a successful operation reports. `outcome` is never inferred by the caller:
// 'written' means "the OS has it", 'durable' means "fsynced and atomically replaced".
//
// R5: `path` names the file a `shard.save` committed, so a receipt can be matched to the
// unit it belongs to without re-deriving the layout. A journal receipt has none - its
// target is (root, sessionId), which the caller already knows.
export type IoWriteReceipt = {
    callId: number;
    kind: IoOperationKind;
    outcome: 'durable' | 'written';
    durationMs: number;
    bytes?: number;
    path?: string;
};

// The receipt of one COMMIT, which under R5 is several shard writes rather than one.
export type IoCommitReceipt = {
    // EVERY shard this commit wrote, in the order it was posted: threads first, then the
    // session files, then the index (`IO_SHARD_ORDER`). A resolved commit means each of
    // these got its own 'durable' receipt - nothing is inferred from the index.
    units: IoWriteReceipt[];
    // The TERMINAL unit of the commit: the index shard when the commit includes one (it
    // normally does), otherwise the last shard it posted. Kept as a named field because a
    // strict caller's question is "did the state become load-bearing", and `index.json` is
    // the file that makes a new session/thread discoverable. It is NOT a claim about the
    // other units - `units` is.
    checkpoint: IoWriteReceipt;
    // Sessions whose journal tail was fsynced ahead of this commit's session shards.
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
    // operations and are not counted). Under R5 an operation is a SHARD, so a commit that
    // touches one conversation is one frame instead of a whole-database frame, and a
    // coalesced-away shard is never posted at all. The invariant an operator can check is
    // unchanged: posted = completed + failed + outstanding, with `late` counting replies
    // that arrived after their operation had been settled.
    posted: number;
    completed: number;
    failed: number;
    // Worker-side faults, and the fault that was not attributable to one operation.
    faults: number;
    lastFault?: string;
    // Best-effort SHARDS replaced by a newer payload for the same path before they were
    // posted. The total answers "how much work did coalescing save"; `supersededByPath`
    // answers the question the whole-document counter could never answer, which is WHICH
    // file is being rewritten over and over.
    superseded: number;
    supersededByPath: Record<string, number>;
    // Operations refused by a configured bound - each one reported through an error
    // channel, never dropped quietly.
    refused: number;
    // Replies that arrived for an operation already settled (a watchdog fired, the queue
    // was failed on shutdown) or a frame this build could not parse.
    late: number;
    // Bytes the worker wrote (every unit that reached its file), and the per-path size
    // accounting that replaces the single whole-document measurement: `lastShardBytes`
    // maps a shard path to the last size the WORKER measured for it, which is the free
    // source of the client's O(1) pre-check - per path, so one oversized shard cannot
    // freeze the others. `lastShardDurationMs` is the off-thread cost of the most recent
    // shard write.
    writtenBytes: number;
    // Shards the worker found ALREADY on disk and therefore did not write. This is the number that
    // answers "the store saved, why did almost nothing hit the disk?" — and it is kept separate from
    // `superseded` (a queued payload replaced before posting) and from `refused` (the client
    // declined to ask), because all three are different answers to "why is `posted` lower than you
    // expected". A skipped shard is STILL durable; the count is bookkeeping, not a warning.
    skippedShards: number;
    lastShardBytes: Record<string, number>;
    lastShardDurationMs: number;
    // Operations POSTED per kind, so "the worker performed my shard commits and my journal
    // fences" is a NUMBER an operator can read, not an inference from the total. It counts
    // posts (the same basis as `posted`), including one that later failed or was refused
    // by the worker.
    postedByKind: Partial<Record<IoOperationKind, number>>;
    // Operations with a callId outstanding right now.
    outstanding: number;
};

// The slice of `HarnessPersistence` this client needs, stated STRUCTURALLY: any object
// carrying the two REQUIRED fields works (tests pass a bare `{ directory, file }`), and the client
// takes no dependency on the class's lifecycle. R5 changed the module graph on purpose:
// the client now imports persistence.ts's LAYOUT PRIMITIVES at runtime (the split, the
// directory derivations, `harnessShardFileOf`), because one file must own where a shard
// goes - but it still never calls the inline writer.
export type HarnessIoPersistenceShape = {
    directory: string;
    file: string;
    // What the last LOADED or COMMITTED document left on disk: which sessions have a
    // `session.json`, and which conversations have a transcript. Optional for the same reason the
    // two fields above are the only required ones — a caller that has not loaded a database (a test
    // double, a fresh in-memory deployment) has nothing to report, and an empty footprint means the
    // client plans NO removals: it can never erase a file it has no evidence about.
    //
    // The client needs this BEFORE its first commit. Without it, a session the restorer dropped
    // during startup would keep its `session.json` forever: the index no longer names that session,
    // and nothing would tell the queue the file is an orphan. `HarnessPersistence.shardFootprint`
    // answers this from the same bookkeeping its inline garbage collector uses (../persistence.ts).
    shardFootprint?: { sessions: readonly string[]; threads: Record<string, readonly string[]> };
};

export type HarnessIoClientOptions = {
    // The database this client commits to: structurally the fields of a
    // `HarnessPersistence`, so the integration is literally
    // `createHarnessIoClient({ persistence: this.persistence, ... })`.
    persistence: HarnessIoPersistenceShape;
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
    // 0 (the default) means unbounded: a shard write is O(1) and the worker drains faster
    // than a token stream produces events. Set a number to make a stalled worker REFUSE
    // queued operations (reported, never silent) instead of growing memory.
    maxPendingOps?: number;
    // A1's split hook: document -> the shard units one commit contains, in any order (this
    // client imposes `IO_SHARD_ORDER` itself). The default, `harnessShardUnitsOf` below, is
    // built ENTIRELY from A1's exported primitives (`splitHarnessSessionRecord`,
    // `harnessIndexDocumentOf`, the directory helpers) so the shard format stays defined in
    // exactly one file; an injectable override exists for tests that need a controlled unit
    // set, not because the default is provisional.
    shardUnits?: (document: HarnessDatabase, persistence: HarnessIoPersistenceShape, savedAt: number) => HarnessShardUnit[];
    // Queued SHARD failures - the worker-mode twin of `SessionStore.notePersistenceError`
    // (../sessions.ts:3655). One per failed shard, so a partial commit names the shard that
    // broke rather than a composite document.
    onCheckpointError?: (error: HarnessIoError) => void;
    // The worker-mode twin of `journal.error` (../journal.ts:260): the message is the
    // raw one, and the store adds its own prefix.
    onJournalError?: (sessionId: string, message: string) => void;
};

// One posted operation waiting for its reply.
type PendingOperation = {
    callId: number;
    kind: IoOperationKind;
    sessionId?: string;
    // For a `shard.save`, the shard path this operation writes: the key its deferred twin
    // and its size measurement are accounted under.
    path?: string;
    // The frame, kept so the handshake gate can write it later without rebuilding it. The
    // unit is a live object, so re-reading it at release time could commit a NEWER state
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
    // The RAW cause of this operation's worker-side failure (`reply.error.cause`), kept
    // so a rejected strict COMMIT can re-stick the error channel with the FIRST unit's
    // raw text - see `commitShardEntries`.
    failureCause?: string;
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

// Node-only reachability: the IO twin of `laneWorkerEnvironment` (./capability.ts:795).
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

// The sentence every entry failure ends with: what the entry has to be, and the two ways
// to point elsewhere. Owned here because this client is the only party that knows what it
// looked for.
export const ioWorkerEntryHelp = (): string =>
    `Point HARNESS_IO_WORKER_ENTRY / the "entry" option at the worker entry module (the package ships it as TypeScript source at "src/server/workers/io-worker.ts", published as the package subpath "${IO_WORKER_PACKAGE_SPECIFIER}"), or unset both and let this client resolve the package's own entry. The thread loads whatever path is resolved through the harness Vite runner (./worker-boot.mjs), so no build step and no Node flag is involved.`;

// Every candidate this resolver tries, in order, with the mode it would load it in.
// Exported for the packaging check and for ./io-client.test.ts, which asserts the chain
// instead of hoping it matches the published layout.
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

    // SOURCE CHECKOUT and published `src/` install alike: the entry module beside this file.
    // There is no sibling `dist/` arm and no "../src" arm - those existed for a bundled
    // layout this package does not publish, and from here they could never resolve.
    add('./io-worker.ts', 'source');

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

        return { path: explicit, mode: 'explicit' };
    }

    const env = options.env ?? (typeof process === 'undefined' ? undefined : process.env);
    const fromEnv = env?.HARNESS_IO_WORKER_ENTRY;

    // 2. Operator escape hatch (a deployment that bundles the entry somewhere else).
    if (typeof fromEnv === 'string' && fromEnv.length > 0) {
        if (!exists(fromEnv)) {
            throw new HarnessIoError('worker-entry-missing', `HARNESS_IO_WORKER_ENTRY points at a file that does not exist: ${fromEnv}. ${ioWorkerEntryHelp()}`, fromEnv);
        }

        return { path: fromEnv, mode: 'env' };
    }

    // 3. The published package subpath, when the exports map carries it. In this package the
    // subpath targets TypeScript source, so this is the entry - not a stand-in for a build.
    try {
        const resolved = createRequire(import.meta.url).resolve(IO_WORKER_PACKAGE_SPECIFIER);

        if (exists(resolved)) return { path: resolved, mode: 'package' };
    } catch {
        // ERR_PACKAGE_PATH_NOT_EXPORTED / ERR_MODULE_NOT_FOUND: not published (yet), so the
        // local candidates below are the honest next step.
        tried.push(`require.resolve(${IO_WORKER_PACKAGE_SPECIFIER})`);
    }

    // 4. The entry module beside this file. The chain is explicit-override first and package
    // resolution second because those are the two ways an operator can point elsewhere; the
    // neighbouring file is the last resort of a plain checkout.
    for (const candidate of ioWorkerEntryCandidates()) {
        if (candidate.mode === 'package') continue;

        if (exists(candidate.path)) return candidate;
    }

    throw new HarnessIoError('worker-entry-missing', `No IO worker entry was found. Looked for: ${tried.join(', ')}. ${ioWorkerEntryHelp()}`);
};

// ---------------------------------------------------------------------------
// The shard split (R5): one `HarnessDatabase` -> the units one commit contains
// ---------------------------------------------------------------------------

// THE default split, and the only place outside ../persistence.ts that assembles units.
// It mirrors `HarnessPersistence.commitShards` (../persistence.ts:2926) step for step,
// using A1's own exported primitives, so the worker commits the same units the inline
// writer would have committed - same set, same shapes, same directories:
//
//   - per session: `splitHarnessSessionRecord` separates the record (no `core.threads[]`
//     message rows) from the transcripts; each transcript becomes a thread unit and the
//     stripped record becomes the session unit. A row with a non-generated id KEEPS its
//     messages inline (no safe file name) exactly as inline does - nothing is dropped.
//   - one index unit: `harnessIndexDocumentOf(database, savedAt)` - the ONLY file that
//     carries a timestamp, stamped ONCE here per commit (the same rule A1 documents: a
//     content shard whose bytes did not change must not move).
//
// The unit carries no file path: `harnessShardFileOf(unit)` is the single derivation of
// where a unit goes, and `shardTargetOf` below is the only caller of it in this file.
export const harnessShardUnitsOf = (
    database: HarnessDatabase,
    persistence: HarnessIoPersistenceShape,
    savedAt: number
): HarnessShardUnit[] => {
    const units: HarnessShardUnit[] = [];

    for (const record of database.sessions) {
        // Split, never mutate: the record is the LIVE one `databaseRecord()` just built
        // from running harnesses (the same reason A1's copy exists).
        const { record: stored, transcripts } = splitHarnessSessionRecord(record);

        for (const transcript of transcripts) {
            units.push({
                kind: 'thread',
                directory: harnessThreadDirectoryOf(persistence.directory, record.id),
                sessionId: record.id,
                id: transcript.id,
                messages: transcript.messages
            });
        }

        units.push({
            kind: 'session',
            directory: harnessSessionDirectoryOf(persistence.directory, record.id),
            sessionId: record.id,
            record: stored
        });
    }

    units.push({ kind: 'index', directory: persistence.directory, document: harnessIndexDocumentOf(database, savedAt) });

    return units;
};

// The frame target for one unit: kind + directory + the canonical file. This is the ONE
// place the client reads a unit's location, and it reads it through A1's derivation, so a
// layout change in persistence.ts cannot silently change which writes supersede each other
// (the coalescing key is `ioShardPath` of this object).
const shardTargetOf = (unit: HarnessShardUnit): IoShardTarget => ({
    kind: unit.kind,
    directory: unit.directory,
    file: harnessShardFileOf(unit)
});

// One queued or posted shard: its target (the key), the unit (the payload A1 owns), and
// the coordinator's stamp for the commit it belongs to.
type ShardEntry = { target: IoShardTarget; unit: HarnessShardUnit; savedAt: number };

// One removal this coordinator owes the disk: the shard files and trees a commit STOPPED naming.
// `files`/`trees` are absolute paths derived through A1's layout primitives — the worker knows
// nothing about where a shard lives, exactly as it does not for `shard.save`, so one file owns the
// layout on both sides. `id` is the coalescing key (`session:<id>` / `threads:<id>`): two plans for
// the same subject replace each other in the deferred slot instead of queueing the same removal
// twice. `target` names the SUBJECT for the per-path statistics and for a refusal; the worker never
// reads it.
type ShardErase = { id: string; target: IoShardTarget; files: readonly string[]; trees: readonly string[] };

// One commit, planned: the shards it writes, the shards it STOPPED naming (and therefore owes the
// disk), and the footprint it leaves. Built once per commit and routed by both paths — awaited by
// the strict commit, stashed by the queued one — so the two modes cannot disagree about what a
// document dropped, which is the whole parity property this file exists to keep.
type ShardCommitPlan = { entries: ShardEntry[]; erases: ShardErase[]; next: ShardFootprint };

// What a commit leaves on disk, in the form the garbage collector needs: the sessions that have a
// `session.json`, and — per LIVE session — the COMPLETE set of conversations that have a
// transcript. "Complete" is what makes a removal safe to compute: a session whose entry is an empty
// set is a session with no transcripts, so a stale transcript under it is an orphan.
type ShardFootprint = { sessions: Set<string>; threads: Map<string, Set<string>> };

// The footprint a list of entries leaves, derived from the ENTRIES themselves rather than by
// re-splitting the document: "what this commit writes" and "what this commit is remembered as
// having written" are then the same set by construction, and no session is split twice per commit.
const shardFootprintOfEntries = (entries: readonly ShardEntry[]): ShardFootprint => {
    const sessions = new Set<string>();
    const threads = new Map<string, Set<string>>();

    for (const entry of entries) {
        const unit = entry.unit;

        if (unit.kind === 'session') {
            sessions.add(unit.sessionId);
            // Ensure the entry exists even for a session with no transcripts, so a leftover
            // transcript under it is recognised as retired rather than as "unknown".
            if (!threads.has(unit.sessionId)) threads.set(unit.sessionId, new Set<string>());
        } else if (unit.kind === 'thread') {
            const ids = threads.get(unit.sessionId) ?? new Set<string>();

            ids.add(unit.id);
            threads.set(unit.sessionId, ids);
        }
    }

    return { sessions, threads };
};

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

// Spawns the worker and returns the client SYNCHRONOUSLY, before the handshake is answered.
//
// This exists because `createHarnessRuntime` / `new SessionStore` (../runtime.ts:140,
// ../sessions.ts:1671) are synchronous today, and a worker-mode store has to be constructible
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

    // The target is validated ONCE here, not per frame: every shard path the client derives
    // hangs off these two values, so an empty directory or index file is a construction
    // mistake and must fail the constructor (the inline writer's `bad-target` equivalent).
    const target: { directory: string; file: string } = { directory: options.persistence.directory, file: options.persistence.file };

    if (target.directory.length === 0 || target.file.length === 0) {
        throw new HarnessIoError('bad-target', 'An IO client needs the persistence directory and file it commits to.');
    }

    // A1 owns the document -> shard-unit split; see `HarnessIoClientOptions.shardUnits`.
    const splitShards = options.shardUnits ?? harnessShardUnitsOf;

    const maxFrameBytes = positiveOr(options.maxFrameBytes, IO_MAX_FRAME_BYTES);
    const maxPendingOps = atLeastZeroOr(options.maxPendingOps, 0);
    const { path: entry } = resolveIoWorkerEntry({ entry: options.entry, env: options.env });

    // The thread is spawned with the plain-JS bootstrap (./worker-boot.mjs), which starts
    // Vite's module runner and imports `entry` (`.ts`) from the process-wide runner server
    // (./worker-runner.ts). The IO protocol is untouched: the boot marker and the frame limit
    // are still the workerData this client has always sent, and `entry`/`port` are additive.
    const runner = openHarnessWorkerSession(entry);

    const worker = new Worker(runner.bootScript, {
        // The boot marker is what lets the loop attach a message loop only when THIS client
        // spawned it, so importing the loop from a test that itself runs in a worker thread
        // stays side-effect free.
        workerData: {
            entry: runner.entryUrl,
            port: runner.transportPort,
            [IO_WORKER_BOOT_KEY]: IO_PROTOCOL_VERSION,
            maxFrameBytes
        },
        transferList: [runner.transportPort]
    });

    const callIds = createIoCallIds();
    const outstanding = new Map<number, PendingOperation>();
    const journalState = new Map<string, { lastError?: string; failures: number }>();

    let closed = false;
    let closing: Promise<IoCloseSummary> | undefined;
    let lastCheckpointError: string | undefined;
    // R5: which shard file the sticky checkpoint error is about (`undefined` when there is
    // no error, or when the failure did not name a file).
    let lastCheckpointPath: string | undefined;
    let bye: { callId: number; resolve: (drained: number) => void; reject: (error: HarnessIoError) => void } | undefined;
    let hello: { resolve: (version: number) => void; reject: (error: HarnessIoError) => void } | undefined;

    const stats: Omit<IoQueueStats, 'outstanding'> = {
        posted: 0,
        completed: 0,
        failed: 0,
        faults: 0,
        superseded: 0,
        supersededByPath: {},
        refused: 0,
        late: 0,
        writtenBytes: 0,
        // Shards the worker found already on disk and did not write (see `IO_DURABLE_OUTCOMES`'
        // note on `shard.save`: a skip is a durability YES, not a maybe). Counted so "why did this
        // commit touch so few files?" is an answer an operator can get without strace.
        skippedShards: 0,
        lastShardBytes: {},
        lastShardDurationMs: 0,
        postedByKind: {}
    };

    // The deferred best-effort slot, ONE entry per shard path. Each entry is the payload
    // captured at the most recent request for that path; every earlier request for the same
    // path is dropped and counted in `stats.superseded`, while writes to other paths are
    // untouched. `deferredScheduled` is one flag for the whole map, so a burst still costs a
    // single microtask and a single pass.
    const deferred = new Map<string, ShardEntry>();
    let deferredScheduled = false;

    // The removals waiting for their turn, keyed by `session:<id>` / `threads:<id>` so a re-plan of
    // the same subject REPLACES the entry instead of queueing the same removal twice. A queued
    // document knows what it dropped (only it does), but the removal has to ride the queue AFTER the
    // writes it follows — hence a slot of its own, drained by `flushDeferred` behind the shard
    // writes of the same turn.
    const deferredErases = new Map<string, ShardErase>();

    // What this coordinator believes is on disk, per session and per conversation — the same pair
    // of facts the inline writer keeps in `HarnessPersistence.writtenSessionIds`/
    // `writtenThreadIds` for its garbage collector (../persistence.ts). Primed from
    // `persistence.shardFootprint` so a session the restorer dropped during startup is STILL known
    // to have had shards, which is the only way a worker-mode boot can clean them up; absent (a
    // test double, an in-memory deployment) means an empty footprint and therefore no removals —
    // the client never erases a file it has no evidence about.
    let writtenSessions = new Set<string>(options.persistence.shardFootprint?.sessions ?? []);
    let writtenThreads = new Map<string, Set<string>>(
        Object.entries(options.persistence.shardFootprint?.threads ?? {}).map(([id, ids]) => [id, new Set<string>(ids)])
    );

    // Per-shard sticky failures, insertion-ordered so the LAST entry is the most recent one
    // - that is what `lastError()` reports, mirroring the single-slot inline channels
    // (`persistence.lastWriteError` at ../persistence.ts:2592, `store.persistenceError` at
    // ../sessions.ts:1893). A
    // success deletes ONLY its own path's failure, so one shard committing cleanly does not
    // erase the report of a different shard that failed in the same commit.
    const shardErrors = new Map<string, string>();

    const syncStickyError = (): void => {
        // Map iteration is INSERTION order, and `rememberShardError` re-inserts on update,
        // so the last entry IS the most recent failure. The loop instead of `Array.at(-1)`
        // is a lib-target constraint (the package targets below es2022), not a style call.
        let latestPath: string | undefined;
        let latestMessage: string | undefined;

        for (const [path, message] of shardErrors) {
            latestPath = path;
            latestMessage = message;
        }

        lastCheckpointError = latestMessage;
        lastCheckpointPath = latestPath;
    };

    // Re-insert (not just set) so an ALREADY failing path moves to the back and becomes the
    // "most recent" failure the sticky channel reports.
    const rememberShardError = (path: string, message: string): void => {
        shardErrors.delete(path);
        shardErrors.set(path, message);
        syncStickyError();
    };

    // The public twin of `notePersistenceError` for QUEUED shard failures (abandoned slots,
    // per-path refusals): sticky per path, then the callback, and a reporter must never
    // change a run - the inline path says the same about `onPersistenceError`
    // (../sessions.ts:858-875).
    const reportCheckpointError = (error: HarnessIoError): void => {
        rememberShardError(error.path ?? '', error.message);

        if (options.onCheckpointError === undefined) return;

        try {
            options.onCheckpointError(error);
        } catch {
            // A reporter must never change a run.
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
            // Same rule as the store's journal reporter (../sessions.ts:5647).
        }
    };

    // A success clears the sticky error, exactly as `journal.error` and
    // `lastWriteError` clear after a good write inline. R5: only the SAME shard path's
    // failure is cleared - a thread shard committing cleanly does not explain away a
    // `session.json` that failed in the same commit.
    const clearError = (pending: PendingOperation): void => {
        if (pending.kind === 'shard.save') {
            if (pending.path !== undefined) shardErrors.delete(pending.path);

            syncStickyError();

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
    //     reads `journal.error` after every append (../sessions.ts:5640-5642), so its twin
    //     `journalError(id)` / `onJournalError` has to see it in both modes, with the
    //     same text (the raw failure, ../journal.ts:260).
    //   - a shard failure has two distinct inline surfaces: the THROWN message (the
    //     wrapper, which is what a 500 body carries) and
    //     `persistence.lastWriteError` (the RAW cause). `sticky` is the latter, remembered
    //     per shard path, and the callback is fired only for a QUEUED save, because an
    //     awaited save rejects and the caller reports it itself - firing both would log one
    //     failure twice.
    const noteFailure = (
        meta: { kind: IoOperationKind; sessionId?: string; path?: string; awaited: boolean },
        error: HarnessIoError,
        sticky: string
    ): void => {
        if (meta.kind !== 'shard.save') {
            if (meta.sessionId !== undefined) reportJournalError(meta.sessionId, error.message);

            return;
        }

        // The sticky channel carries the RAW cause, like inline `lastWriteError`; the path
        // is the shard this failure belongs to, which `settle` already put on `error`.
        rememberShardError(error.path ?? meta.path ?? '', sticky);

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

        // A dead thread means nothing outstanding can become durable, and the same is true
        // for every queued shard: each is reported (per path) and counted, never silently
        // dropped.
        const abandoned = [...deferred.values()];

        deferred.clear();
        // A removal that never got posted leaves its orphan on disk. That is not a lost write: the
        // shard saves above are what the caller was told about, and the collector runs again for any
        // footprint change it has not yet acted on, so there is nothing to report beyond the dead
        // thread itself.
        deferredErases.clear();
        deferredScheduled = false;
        stats.superseded += abandoned.length;

        for (const entry of abandoned) {
            reportCheckpointError(
                new HarnessIoError(
                    error.code,
                    `A queued ${entry.target.kind} shard save was abandoned: ${error.message}`,
                    entry.target.file
                )
            );
        }
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

        // A shard reply carries the true serialized length for ITS OWN file, whether or not
        // anything was written (a size refusal still measures the unit). That measurement is
        // what makes the client's frame-size guard O(1) instead of another stringify, and it
        // is accounted PER PATH so one oversized shard cannot freeze the others. A fault
        // names no measurement at all, so it updates nothing.
        if (pending.kind === 'shard.save' && pending.path !== undefined && reply.kind !== 'fault') {
            if (typeof reply.bytes === 'number') stats.lastShardBytes[pending.path] = reply.bytes;

            stats.lastShardDurationMs = reply.durationMs;
        }

        if (reply.kind === 'result') {
            stats.completed += 1;

            // `writtenBytes` counts bytes that reached the file, so a refused oversized
            // document does not inflate it — and a SKIP does not either: the worker measured
            // those bytes and wrote nothing, so they go to `skippedShards` instead. Keeping the
            // two apart is what lets an operator tell "this commit changed almost nothing" from
            // "this commit wrote almost nothing".
            if (reply.skipped === true) stats.skippedShards += 1;
            else if (typeof reply.bytes === 'number') stats.writtenBytes += reply.bytes;

            clearError(pending);

            pending.resolve({
                callId: pending.callId,
                kind: pending.kind,
                outcome: reply.outcome,
                durationMs: reply.durationMs,
                ...(reply.bytes === undefined ? {} : { bytes: reply.bytes }),
                // R5: a shard receipt names the file it committed, so a commit receipt's
                // `units` list can be matched to the units it posted without re-deriving
                // the layout. Journal receipts have no path - their target is (root,
                // sessionId), which the caller already knows.
                ...(pending.path === undefined ? {} : { path: pending.path })
            });

            return;
        }

        stats.failed += 1;

        const error =
            reply.kind === 'failure'
                ? new HarnessIoError(reply.error.code, reply.error.message, reply.error.path, pending.callId)
                : new HarnessIoError('io-fault', reply.message, undefined, pending.callId);

        // Keep the raw cause on the record so a rejected strict COMMIT can report the
        // FIRST failing shard's cause (see `commitShardEntries`).
        if (reply.kind === 'failure') pending.failureCause = reply.error.cause ?? reply.error.message;

        if (reply.kind === 'fault') {
            stats.faults += 1;
            stats.lastFault = reply.message;
        }

        noteFailure(pending, error, reply.kind === 'failure' ? reply.error.cause ?? reply.error.message : reply.message);

        pending.reject(error);
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

        // Per-kind post counts, taken at the post (not at the reply): an operation that fails on
        // the worker still cost a frame, and a caller proving "the fence was posted before the
        // save" needs the count of what left this thread.
        stats.postedByKind[pending.kind] = (stats.postedByKind[pending.kind] ?? 0) + 1;

        try {
            worker.postMessage(pending.frame);
        } catch (error) {
            // A DataCloneError lands here: a value that is not structured-cloneable fails
            // THIS operation with a named reason instead of vanishing into the port, and the
            // queue stays usable.
            outstanding.delete(pending.callId);
            stats.failed += 1;

            const cloneError = new HarnessIoError(
                'not-cloneable',
                `This frame could not be sent to the IO worker: ${errorText(error)}`,
                pending.path ?? target.file,
                pending.callId
            );

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
    const post = (
        kind: IoOperationKind,
        body: Record<string, unknown>,
        meta: { awaited: boolean; sessionId?: string; path?: string }
    ): PendingOperation => {
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
            ...(meta.sessionId === undefined ? {} : { sessionId: meta.sessionId }),
            ...(meta.path === undefined ? {} : { path: meta.path })
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

    // Builds the entries of one commit: the unit set from the split, each paired with its
    // frame target, ordered for the disk (`IO_SHARD_ORDER` via `orderIoShardUnits`, stable
    // within a kind so a session's threads keep their document order). The ONE place split,
    // targeting and ordering meet, so the strict path and the queued path can never disagree
    // about which units a commit contains.
    const shardEntriesOf = (document: HarnessDatabase, savedAt: number): ShardEntry[] =>
        orderIoShardUnits(splitShards(document, options.persistence, savedAt).map((unit) => ({ target: shardTargetOf(unit), unit, savedAt })));

    // Releases the deferred shards, if any. Runs before any other post so the FIFO order
    // the caller experienced is the order the worker executes. R5: the map fills in call
    // order, but it POSTS in DISK order - a thread shard still lands before its
    // `session.json`, and that before `index.json`, even though all three were requested in
    // one synchronous burst.
    const flushDeferred = (): void => {
        const entries = orderIoShardUnits([...deferred.values()]);
        const erases = [...deferredErases.values()];

        deferred.clear();
        deferredErases.clear();
        deferredScheduled = false;

        if (entries.length === 0 && erases.length === 0) return;

        for (const entry of entries) post('shard.save', { target: entry.target, unit: entry.unit, savedAt: entry.savedAt }, { awaited: false, path: ioShardPath(entry.target) });

        // Removals go LAST, behind every write of the same turn, which is the same position the
        // inline writer gives them (../persistence.ts runs its garbage collector after the index is
        // durable). The order is load-bearing rather than tidy: a dropped session's shard can still
        // be sitting in the slot ABOVE (a queued save from before the drop), and posting the removal
        // first would let that write resurrect the orphan the removal just deleted.
        for (const erase of erases) postShardErase(erase);
    };

    // A strict commit makes the queued best-effort entries for the SAME PATHS redundant:
    // inline paid for both commits, worker mode pays for one and says so - per path, which
    // is the question the whole-document counter could never answer.
    const dropDeferredForPaths = (paths: Iterable<string>): void => {
        for (const path of paths) {
            if (!deferred.delete(path)) continue;

            stats.superseded += 1;
            stats.supersededByPath[path] = (stats.supersededByPath[path] ?? 0) + 1;
        }
    };

    // A REMOVAL makes every queued write under the same prefix pointless, and dropping them is not
    // cosmetic: a queued shard posted AFTER the erase would resurrect the orphan the erase just
    // deleted, and the store would then hold a `session.json` no header names — a file `load()`
    // ignores but a reader (and the next operator) does not. Counted as `superseded` per path, the
    // same way a strict commit's overwrite is, because that is exactly what happened to it.
    const dropDeferredUnder = (prefix: string): void => {
        for (const shardPath of [...deferred.keys()]) {
            if (!shardPath.startsWith(prefix)) continue;

            deferred.delete(shardPath);
            stats.superseded += 1;
            stats.supersededByPath[shardPath] = (stats.supersededByPath[shardPath] ?? 0) + 1;
        }
    };

    // Hands one removal to the queue UNAWAITED, which is what keeps the durability story
    // unchanged: a strict commit's receipt still says "every SHARD of this document is durable" and
    // never claims a removal, exactly as inline `save()` never claims its garbage collector ran
    // (it is best-effort, after the index is durable, and a failure there only costs disk).
    //
    // Because the queue is FIFO, the frame lands after every write that was posted before it —
    // which is the whole reason a removal can be posted at all without a new durability outcome.
    const postShardErase = (erase: ShardErase): void => {
        // The leftover writes this removal invalidates are dropped at post time, not plan time: a
        // queued shard can arrive between the two.
        dropDeferredUnder(`${erase.target.directory}${path.sep}`);

        post('shard.erase', { target: erase.target, files: [...erase.files], trees: [...erase.trees] }, { awaited: false, path: erase.target.file });
    };

    // The removals one commit owes, from the footprint it is about to replace. The SAME set the
    // inline `eraseVanishedShards` erases (../persistence.ts):
    //
    //   - a session the document stopped naming loses its `session.json` and its whole `threads/`
    //     tree, and KEEPS its `events.jsonl` — "row erased, journal kept" is v1's outcome and what
    //     ./sessions.ts `remove()` (../sessions.ts:11302-11303) counts on;
    //   - a conversation retired by the record cap (./sessions.ts `capThreadRecords`) loses just
    //     its transcript file, not the session's other conversations.
    //
    // Every path goes through A1's layout primitives, so the coordinator can never erase something
    // the writer would not have written, and the worker stays as layout-agnostic as it is for
    // `shard.save`.
    const shardErasesOf = (next: ShardFootprint): ShardErase[] => {
        const erases: ShardErase[] = [];

        for (const id of writtenSessions) {
            if (next.sessions.has(id)) continue;

            const file = harnessSessionFileOf(target.directory, id);

            erases.push({
                id: `session:${id}`,
                // `target` names the SUBJECT for the per-path statistics and for a refusal; the
                // worker reads only `files`/`trees`.
                target: { kind: 'session', directory: harnessSessionDirectoryOf(target.directory, id), file },
                files: [file],
                trees: [harnessThreadDirectoryOf(target.directory, id)]
            });
        }

        for (const [id, previous] of writtenThreads) {
            // A vanished session already took its whole `threads/` tree with it above.
            if (!next.sessions.has(id)) continue;

            const kept = next.threads.get(id);
            const retired: string[] = [];

            for (const threadId of previous) {
                if (kept !== undefined && kept.has(threadId)) continue;

                retired.push(threadId);
            }

            if (retired.length === 0) continue;

            const directory = harnessThreadDirectoryOf(target.directory, id);
            const files = retired.map((threadId) => harnessThreadFileOf(target.directory, id, threadId));

            erases.push({ id: `threads:${id}`, target: { kind: 'thread', directory, file: files[0]! }, files, trees: [] });
        }

        return erases;
    };

    // A commit that WRITES a session cancels a removal still waiting for it: the file is about to
    // exist again, and anything that session still owes (a cap-retired transcript) is re-derived by
    // `shardErasesOf` from the footprint, which still names it. Without this, a queued removal
    // flushed by the commit's own first frame would delete a shard the commit is writing.
    const dropDeferredErasesFor = (next: ShardFootprint): void => {
        for (const id of next.sessions) deferredErases.delete(`session:${id}`);
        for (const id of next.threads.keys()) deferredErases.delete(`threads:${id}`);
    };

    // The removals one commit owes, paired with the footprint it leaves, computed in one place so
    // the strict and the queued path cannot disagree about what a document dropped. Called BEFORE
    // any frame of the commit is posted; the footprint itself is only remembered once the removals
    // are actually routed (see `noteShardCommit`), so a commit that fails before posting them gets
    // a second attempt instead of losing the removal.
    const shardCommitPlanOf = (document: HarnessDatabase, savedAt: number): ShardCommitPlan => {
        const entries = shardEntriesOf(document, savedAt);
        const next = shardFootprintOfEntries(entries);

        dropDeferredErasesFor(next);

        return { entries, erases: shardErasesOf(next), next };
    };

    // Remembers what this commit left on disk. Routed at the moment the commit's removals are
    // handed to the queue — after the awaited shards for the strict path, at queue time for the
    // deferred one — because that is the instant the removal becomes someone else's job.
    const noteShardCommit = (next: ShardFootprint): void => {
        writtenSessions = next.sessions;
        writtenThreads = next.threads;
    };

    const scheduleDeferred = (): void => {
        if (deferredScheduled) return;

        deferredScheduled = true;

        // A microtask is the right granularity: every save queued in the same
        // synchronous turn collapses into one commit per touched shard, of the newest
        // payload for that shard.
        queueMicrotask(() => {
            if (!deferredScheduled) return;

            if (deferred.size === 0 && deferredErases.size === 0) {
                // A strict operation released the paths first; nothing left to post.
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
    const refuse = (meta: { kind: IoOperationKind; sessionId?: string; path?: string; awaited: boolean }, message: string, code: string): HarnessIoError => {
        stats.refused += 1;

        // R5: the refused SUBJECT is named - the shard file for a shard refusal, the
        // database directory for a journal one ("the harness database" is no longer one
        // file a refusal can point at).
        const error = new HarnessIoError(code, message, meta.path ?? target.directory);

        noteFailure(meta, error, message);

        return error;
    };

    // The per-path size pre-check, from the last size the WORKER measured FOR THIS PATH (a
    // size refusal still measures, so one round trip is enough to learn an oversized shard).
    // A shard that is permanently oversized stops costing a clone and a serialization; the
    // worker's own check, on the true serialized length, is what decides the first commit.
    const oversizedShardOf = (entry: ShardEntry): number | undefined => {
        const measured = stats.lastShardBytes[ioShardPath(entry.target)];

        return measured !== undefined && measured > maxFrameBytes ? measured : undefined;
    };

    const refuseOversizedShard = (entry: ShardEntry, measured: number, awaited: boolean): HarnessIoError =>
        refuse(
            { kind: 'shard.save', awaited, path: entry.target.file },
            `The ${entry.target.kind} shard ${entry.target.file} measured ${measured} bytes on its last measurement, above the ${maxFrameBytes} byte frame limit.`,
            'frame-too-large'
        );

    // The frame body for one JOURNAL operation: the (root, sessionId) target. A SHARD frame
    // carries its own target - every unit addresses its own file - so it never comes through
    // here. Centralized so a caller can never post a frame that addresses the wrong file.
    const frameBody = (body: Record<string, unknown>, sessionId?: string): Record<string, unknown> => ({
        target: { root: target.directory, sessionId: sessionId ?? '' },
        ...body
    });

    // The shared entry point for the JOURNAL operations (both flavours). The checkpoint
    // paths - `saveCheckpoint`, `commitCheckpoint`, `queueCheckpointSave` - post shard
    // frames directly, because one commit is several frames with per-unit targets; they
    // apply the same closed/depth/size rules themselves, unit by unit.
    const run = (kind: IoOperationKind, body: Record<string, unknown>, meta: { sessionId?: string; awaited: boolean }): Promise<IoWriteReceipt> => {
        if (closed) {
            const message = `The IO client is closed, so ${kind} was not performed.`;

            if (!meta.awaited) {
                refuse({ kind, ...(meta.sessionId === undefined ? {} : { sessionId: meta.sessionId }), awaited: false }, message, 'client-closed');

                return Promise.resolve({ callId: 0, kind, outcome: 'written', durationMs: 0 });
            }

            return Promise.reject(refuse({ kind, ...(meta.sessionId === undefined ? {} : { sessionId: meta.sessionId }), awaited: true }, message, 'client-closed'));
        }

        // A queued operation cannot re-ask, so a depth bound on it is a real policy:
        // refuse with a reason. A strict operation is not refused for depth - the
        // caller's own await is the backpressure - but its refusal is still counted, so
        // "the client said no" is distinguishable from "the disk said no".
        if (!meta.awaited && maxPendingOps > 0 && outstanding.size >= maxPendingOps) {
            refuse({ kind, ...(meta.sessionId === undefined ? {} : { sessionId: meta.sessionId }), awaited: false }, `The IO queue holds ${outstanding.size} operations, at the configured limit of ${maxPendingOps}.`, 'queue-full');

            return Promise.resolve({ callId: 0, kind, outcome: 'written', durationMs: 0 });
        }

        flushDeferred();

        return post(kind, frameBody(body, meta.sessionId), { awaited: meta.awaited, ...(meta.sessionId === undefined ? {} : { sessionId: meta.sessionId }) }).promise;
    };

    // ONE strict commit, shared by `saveCheckpoint` and `commitCheckpoint`: fences first,
    // then every shard of the commit in `IO_SHARD_ORDER`, every frame awaited. The worker
    // queue is FIFO and each shard is renamed atomically, so the posting order below IS the
    // on-disk order: the journal tail fsynced, then the thread shards, then the
    // `session.json` that lists them, then the `index.json` that makes them discoverable.
    //
    // A commit resolves only when EVERY unit reached its own durability boundary, and
    // rejects with the FIRST failure in posted order - while the units that already
    // committed STAY committed. That is not a half-written file: each file is whole, and
    // the order means a published file never references a shard that was skipped. (The
    // size pre-check refusing one unit is the same situation, reached without a frame.)
    //
    // The plan's REMOVALS ride the same queue, unawaited, after the commit succeeded - see the
    // posting site below.
    const commitShardEntries = async (plan: ShardCommitPlan, fenceSessions: readonly string[] = []): Promise<IoCommitReceipt> => {
        const { entries, erases, next } = plan;

        // Checked here as well as in `run`: this path posts directly, and an
        // operation posted to a thread that is already closing would otherwise wait
        // for a reply that can never arrive.
        if (closed) {
            throw new HarnessIoError('client-closed', 'The IO client is closed; the checkpoint was not committed.', target.file);
        }

        // A commit of NO units is a broken split, not a no-op: resolving one would let the
        // caller claim durability for a state that reached no file at all.
        if (entries.length === 0) {
            throw new HarnessIoError('no-units', 'The checkpoint split produced no shard units, so there was nothing to commit.', target.file);
        }

        // The commit's document is newer than anything still sitting in the slot, for
        // exactly these paths - a queued shard the commit does NOT touch stays queued.
        dropDeferredForPaths(entries.map((entry) => ioShardPath(entry.target)));

        const fences = fenceSessions.map((sessionId) => post('journal.flush', frameBody({}, sessionId), { awaited: true, sessionId }).promise);

        const units: { entry: ShardEntry; pending?: PendingOperation; refusal?: HarnessIoError }[] = entries.map((entry) => {
            const measured = oversizedShardOf(entry);

            // A known-oversized unit refuses ONLY itself: its siblings still commit, and
            // the partial commit is reported per unit, never folded into a composite claim.
            if (measured !== undefined) return { entry, refusal: refuseOversizedShard(entry, measured, true) };

            return { entry, pending: post('shard.save', { target: entry.target, unit: entry.unit, savedAt: entry.savedAt }, { awaited: true, path: ioShardPath(entry.target) }) };
        });

        const [fenceResults, unitResults] = await Promise.all([
            Promise.allSettled(fences),
            Promise.allSettled(units.map((unit) => unit.pending?.promise ?? Promise.reject(unit.refusal)))
        ]);

        const failedIndex = unitResults.findIndex((result) => result.status === 'rejected');

        if (failedIndex !== -1) {
            const failed = units[failedIndex];
            const reason = asIoError((unitResults[failedIndex] as PromiseRejectedResult).reason);

            // PARITY RESTICK. The inline `save()` THROWS at its first failing unit and
            // never reaches the ones after it, so its `lastWriteError` describes THAT
            // failure. Here every unit was already posted (the queue cannot know the first
            // one would fail), so later units may have failed too and overwritten the
            // sticky channel. Re-insert the FIRST failure last: the sticky reports what
            // the inline writer would have reported, while the later failures stay recorded
            // under their own paths - they are real, they are just not the headline.
            rememberShardError(failed.refusal === undefined ? failed.pending?.path ?? failed.entry.target.file : failed.entry.target.file, failed.pending?.failureCause ?? reason.message);

            throw reason;
        }

        // Every shard of this document is durable, so anything the document STOPPED naming is now an
        // orphan. The removals are posted HERE — last, behind the writes, which is exactly where the
        // inline writer puts its garbage collector (../persistence.ts erases after the index is
        // durable) — and UNAWAITED, for three reasons that together mean no durability claim moved:
        //
        //   - the receipt still says "every SHARD of this document is durable" and says nothing about
        //     a removal, which is the claim inline `save()` makes as well;
        //   - a removal that fails therefore costs one `stats.failed` tick and a leftover file, not a
        //     rejected DELETE: `noteFailure` reports only `shard.save` and journal kinds, so an erase
        //     failure never enters the sticky channel — matching inline, which swallows its unlink
        //     failures outright;
        //   - the queue is FIFO, so this frame lands after every write above it and cannot delete a
        //     shard this same commit just wrote.
        //
        // A commit that REJECTED above never reaches this line, so its removals stay owed: the
        // footprint below is moved only once they are posted, and the next commit re-plans them.
        for (const erase of erases) postShardErase(erase);

        noteShardCommit(next);

        if (fenceSessions.length > 0) {
            const failed = fenceResults.find((result) => result.status === 'rejected');

            if (failed !== undefined && failed.status === 'rejected') {
                const reason = asIoError(failed.reason);

                throw new HarnessIoError(
                    reason.code === 'client-closed' ? 'client-closed' : 'journal',
                    `The checkpoint is durable, but the journal fsync ordered ahead of it failed: ${reason.message}`
                );
            }
        }

        const receipts = unitResults.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));

        // `orderIoShardUnits` puts `index` last, so when the commit includes one (every
        // split does), the terminal receipt IS the index write - the file that makes the
        // new state load-bearing. It is NOT a claim about the other units: `receipts` is.
        const checkpoint = receipts[receipts.length - 1];

        return { units: receipts, checkpoint, fenced: [...fenceSessions] };
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
                        `The IO worker entry ${entry} speaks protocol version ${data.version}; this server requires ${IO_PROTOCOL_VERSION}. The entry and the server must come from the same checkout: mismatched sources mis-parse receipts.`,
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

        // The thread is gone, so its module-runner port is dead: release it, and with the
        // last live worker the shared Vite runner server closes too (./worker-runner.ts).
        runner.dispose();

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

        // The checkpoint a caller waits for: resolves once EVERY shard of this document
        // has been durably renamed by the worker (threads, then each `session.json`, then
        // `index.json`), and rejects with the message the inline `save()` would have thrown
        // for the first shard that failed.
        saveCheckpoint: async (document, saveOptions) =>
            (await commitShardEntries(shardCommitPlanOf(document, saveOptions?.savedAt ?? Date.now()))).checkpoint,

        // The terminal commit shape the store needs: fence the journal tail of the
        // sessions whose events this document lists, then commit the shards, and only
        // then may the response go out.
        //
        // Ordering comes from the queue (the flushes are posted first, the shards follow
        // in `IO_SHARD_ORDER`); the fence's durability comes from awaiting them. A failed
        // fence with successful shards is reported as exactly that, instead of pretending
        // nothing was durable or claiming everything was.
        commitCheckpoint: (commitOptions) =>
            commitShardEntries(
                shardCommitPlanOf(commitOptions.document, commitOptions.savedAt ?? Date.now()),
                commitOptions.fenceSessions ?? []
            ),

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

        // The newest payload wins PER SHARD PATH: a replaced entry is counted as
        // `superseded` (in total and per path) and is never presented as a durable commit,
        // while entries for other shards are untouched. One synchronous burst of
        // `noteStateChange` still costs one split and one serialization per touched shard.
        queueCheckpointSave: (document, saveOptions) => {
            if (closed) {
                refuse({ kind: 'shard.save', awaited: false }, 'The IO client is closed, so a queued checkpoint was not performed.', target.file);

                return;
            }

            // A queued request cannot re-ask, so a depth bound on it is a real policy:
            // refuse the REQUEST with a reason and leave the queued slots alone.
            if (maxPendingOps > 0 && outstanding.size >= maxPendingOps) {
                refuse({ kind: 'shard.save', awaited: false }, `The IO queue holds ${outstanding.size} operations, at the configured limit of ${maxPendingOps}.`, 'queue-full');

                return;
            }

            const savedAt = saveOptions?.savedAt ?? Date.now();
            // One plan for the whole document: the shards it writes AND the shards it stopped
            // naming. The removals are computed now because this is the only moment the dropped
            // session is known at all (the next document simply does not mention it), but they may
            // not be POSTED now: they have to ride the queue behind the writes of this turn, which is
            // what `deferredErases` and `flushDeferred` are for.
            const plan = shardCommitPlanOf(document, savedAt);

            for (const erase of plan.erases) deferredErases.set(erase.id, erase);

            // The footprint moves at queue time for this path: unlike the strict commit there is no
            // await to hang a success on, and the queued write of the new `index.json` — which is
            // what makes the removal true — is already in the slot with these frames behind it.
            noteShardCommit(plan.next);

            for (const entry of plan.entries) {
                // The per-path size pre-check: a permanently oversized conversation stops
                // costing a clone, and every OTHER shard of the same document is still
                // queued and committed.
                const measured = oversizedShardOf(entry);

                if (measured !== undefined) {
                    refuseOversizedShard(entry, measured, false);

                    continue;
                }

                const path = ioShardPath(entry.target);

                if (deferred.has(path)) {
                    stats.superseded += 1;
                    stats.supersededByPath[path] = (stats.supersededByPath[path] ?? 0) + 1;
                }

                deferred.set(path, entry);
            }

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
        // `coalescedShards` is how many shard paths are waiting in the deferred slot (R5:
        // per PATH, not one document-sized yes/no), and `measuredShards` is how many shard
        // paths carry a worker-measured size the O(1) pre-check can consult for free.
        pending: () => ({ operations: outstanding.size, gated: gated.length, coalescedShards: deferred.size, measuredShards: Object.keys(stats.lastShardBytes).length }),

        // Every mutable map is copied so a reporter cannot mutate the live counters through
        // the snapshot it was handed.
        stats: (): IoQueueStats => ({
            ...stats,
            supersededByPath: { ...stats.supersededByPath },
            lastShardBytes: { ...stats.lastShardBytes },
            postedByKind: { ...stats.postedByKind },
            outstanding: outstanding.size
        }),

        // The worker-mode twin of `persistence.lastWriteError` (../persistence.ts:2592):
        // the MOST RECENT shard failure's raw text; `lastErrorPath()` names the shard file
        // it belongs to, which the single whole-document error never could.
        lastError: () => lastCheckpointError,
        lastErrorPath: () => lastCheckpointPath,

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

                // The runner port belongs to this thread; nothing is served on it once the
                // thread is terminated.
                runner.dispose();

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
    // Strict, awaited. A "checkpoint" is now the WHOLE shard set the document decomposes
    // into (threads, then each `session.json`, then `index.json`); the promise resolves
    // only once every one of them is durable, and the receipt returned is the TERMINAL
    // unit's (the index write when the commit includes one - see `IoCommitReceipt`).
    saveCheckpoint(document: HarnessDatabase, options?: { savedAt?: number }): Promise<IoWriteReceipt>;
    commitCheckpoint(options: { document: HarnessDatabase; fenceSessions?: readonly string[]; savedAt?: number }): Promise<IoCommitReceipt>;
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
    // Queued, ordered, never throws, no durability claim. Coalescing is PER SHARD PATH:
    // the newest payload per path wins; other paths are untouched.
    queueCheckpointSave(document: HarnessDatabase, options?: { savedAt?: number }): void;
    queueJournalOpen(sessionId: string): void;
    queueJournalAppend(sessionId: string, record: IoJournalRecord): void;
    queueJournalFlush(sessionId: string): void;
    queueJournalRewrite(sessionId: string, records: readonly IoJournalRewriteRecord[]): void;
    queueJournalTruncate(sessionId: string): void;
    queueJournalRemove(sessionId: string): void;
    queueJournalClose(sessionId: string): void;
    // Observability.
    pending(): { operations: number; gated: number; coalescedShards: number; measuredShards: number };
    stats(): IoQueueStats;
    lastError(): string | undefined;
    // The shard file the most recent sticky failure belongs to (`undefined` when there is
    // no failure or it did not name a file).
    lastErrorPath(): string | undefined;
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
//   // synchronous store constructor (../runtime.ts:140 and ../sessions.ts:1671 are sync):
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
//   1. `persistOrThrow()` (../sessions.ts:3555)
//        -> `await io.saveCheckpoint(this.databaseRecord(overrides))` inside the SAME
//           try/catch, so a failed durable commit is still a 500 carrying the same
//           message. R5: that call now commits the WHOLE shard set the document
//           decomposes into - every `threads/<id>.json`, every `session.json`, then
//           `index.json` (in that order, one durable rename each) - and resolves only
//           when all of them are durable. Every caller of it becomes async; that is
//           inherent to "durable before the response" and is the only broad change worker
//           mode needs. No state-observer refactor is required (see 2).
//   2. `persistBestEffort()` (1970), `checkpoint()` (3386) and `noteStateChange()` (2012)
//        -> `io.queueCheckpointSave(this.databaseRecord())`. These are synchronous
//           observers and STAY synchronous: per-path coalescing turns a burst of observer
//           fires into one write PER TOUCHED SHARD (a token stream rewrites one thread
//           file, not an 110 MB document). `session.core = harness.snapshot()` stays on the
//           coordinator immediately before the queue call.
//   3. `journalAppend()` (3327)
//        -> `io.queueJournalAppend(session.id, { turnId, index, at, event })`, then read
//           `io.journalError(session.id)` where the inline code reads `journal.error`.
//           Per-session ordering is preserved by the queue (the recorder's own order is
//           the file's order).
//   4. A terminal transition that must be durable before the response
//        -> `await io.commitCheckpoint({ document, fenceSessions: [session.id] })`.
//           The fences are posted FIRST, so each session's journal fsync lands before the
//           first shard rename this commit publishes. Leaving `fenceSessions` out is
//           byte-for-byte inline parity (no fsync the inline path never performed);
//           including it is strictly stronger. The resolved `IoCommitReceipt` names every
//           shard it wrote (`units`) and the terminal index write (`checkpoint`).
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
//
// WHAT WORKER MODE REPLICATES SOMEWHERE ELSE (R5 honesty)
// --------------------------------------------------------
//   - The digest skip is not coordinator state any more, and WHERE it lives is a real
//     difference: the stamp map is on the WORKER (`committedShards`, ./io-worker-loop.ts),
//     because only the worker holds the serialized bytes and therefore the digest -
//     `commitShardIfChanged` (../persistence.ts:2994) is the inline twin of the same rule, not
//     its owner. Two consequences follow. The map is per worker thread, so a restarted worker
//     re-commits every shard ONCE (identical bytes, syscalls not skipped); and a skip answers
//     `result` with `skipped: true` - the `bytes` still ride along so the frame-size cache
//     below keeps working, while the client counts the skip in `stats.skippedShards` instead
//     of `writtenBytes` (../persistence.ts's inline skip has no such counter, because inline
//     there is no thread to report to).
//   - Vanished-shard garbage collection is shared CODE, not a shared call site: both modes
//     remove the same bytes through `eraseHarnessShardPaths` (../persistence.ts:3086), which
//     inline `eraseVanishedShards` (:3025-3052) also calls, but inline `save()` erases INSIDE
//     the commit while worker mode posts a `shard.erase` frame the coordinator plans from
//     `persistence.shardFootprint`. The plan is computed on the coordinator so the worker stays
//     as layout-agnostic as its other handlers, and it is posted UNAWAITED AFTER the shard
//     writes of the same commit. So no new durability outcome exists: an erase that fails (or
//     a crash before the frame drains) leaves the orphan the ordering above already allows,
//     and the failure is reported under code `shard-erase` without touching the sticky channel.
//   - The size pre-check is a CACHE of the last measurement PER PATH, so it is sticky in
//     exactly the way v1's single global `lastCheckpointBytes` was: a refusal produces no
//     worker reply, so nothing shrinks the number on its own, and the next save of the
//     same path is refused before it is posted even if that document would have fit. R5
//     only narrows the blast radius - v1 refused EVERY checkpoint once one document was
//     measured over the bound, worker mode refuses the one oversized shard and its
//     siblings still commit. The cache is CLIENT state, not disk state: a fresh client on
//     the same root re-measures from scratch (./io-client.test.ts, 'commits the shards
//     that fit and refuses only the oversized one, per path').

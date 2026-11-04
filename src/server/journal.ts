// Per-step durable journal (R4).
//
// `state.json` (./persistence.ts) is a CHECKPOINT: one atomic full-document replace.
// Rewriting it for every harness event is O(every session's every event), and text
// deltas were previously not durable at all until the terminal save. The journal is
// the other half of durability: an append-only, one-line-per-event log under
//
//     <databaseRoot>/harness/sessions/<sessionId>/events.jsonl
//
// which is O(1) per event and survives a crash. `state.json` keeps everything else
// (core snapshot, roster, labels, queue) exactly as before, and its shape/version is
// UNCHANGED, so a database written before this file existed still loads (the journal
// directory is simply absent — see ./sessions.ts restore fallback).
//
// Read model (the two rules the brief pins):
//   - a TRUNCATED LAST LINE is a crash artifact and is TOLERATED (the record was
//     never complete, so dropping it is exact); reported as `truncatedTail`.
//   - corruption ANYWHERE ELSE is EXPLICIT: a malformed middle line, an unknown
//     version, or a per-turn index gap produces a `JournalProblem` with
//     `tail: false`, which the store surfaces through the restore reporter rather
//     than pretending the log was healthy. A reader must never treat a repaired-by-
//     skipping stream as valid.
//
// Durability/error policy (no blanket swallowing):
//   - `append` is best-effort: a failed write NEVER throws into a running turn (a
//     full disk must not change a run's outcome — the same rule as
//     `SessionStore.persistBestEffort`, ./sessions.ts:1586), but the failure is
//     retained in `lastError` and counted so the store can surface it.
//   - the terminal checkpoint stays strict where it already is
//     (`persistOrThrow`, ./sessions.ts:1561), and `flush()`/`rewrite()`/`open()`
//     record errors the same way instead of throwing at the run.
//
// Durability levels, stated exactly (R4/D4):
//   - `append` is `writeSync` on a held fd: safe across a PROCESS crash, not fenced
//     against a power loss. This is the level the store has always relied on, and the
//     inline store still never calls `flush()` itself (only `close()` at dispose, which
//     flushes first), so `ioExecution: 'inline'` changes nothing here.
//   - `flush()` is the fsync fence. A caller that wants "every event of this turn is
//     on stable storage before the response" awaits a flush (the IO client exposes it
//     as an operation ordered ahead of the checkpoint that references those events).
//     D4 ADOPTS IT: a terminal store commit (`persistOrThrow(undefined, { fenceSessions:
//     [session.id] })` at a cancel / cancelThread / turn-start / command-terminal site)
//     maps to `io.commitCheckpoint`, which fences that session's tail before the rename.
//     That is STRICTER than inline, never weaker - inline keeps its existing levels.
//   - `rewrite()` is now fsync-then-rename: a compaction publishes complete bytes.
//
// WORKER MODE (R1/D4): who calls what
// ------------------------------------
// WHEN an io client owns a journal, writes go to one IO worker thread
// (./workers/io-worker.ts), which instantiates THIS class verbatim and holds the append
// fd there. That is no longer hypothetical: `SessionStore` opens a client whenever
// `runtime.ioExecution === 'worker'` (./sessions.ts, D4), and in that mode the coordinator
// keeps a journal instance ONLY as a reader - it never calls a write method on it. With the
// default `ioExecution: 'inline'` nothing changes: one process, one thread, one writer.
// Consequences a caller must respect either way:
//   - Do not call `open`/`append`/`flush`/`rewrite`/`truncate`/`remove`/`close` on a
//     coordinator-side instance while a worker owns the same session: two append
//     handles on one file is a second writer, which is exactly what the FIFO queue
//     exists to prevent.
//   - `read()` and `exists()` DO stay on the coordinator (restore runs before the
//     server serves, and the reader is the checkpoint's owner). They are safe against
//     a worker-held append fd: Node opens with read sharing, and the worker closes its
//     handle before a `rewrite()` rename.
//   - `rewrite()`'s staging name is `<file>.<pid>.<ms>.tmp`. A worker thread shares
//     `process.pid` with the coordinator, so the one-writer rule above is also what
//     keeps two staging names from ever colliding.
//
// Cross-references:
//   - ./sessions.ts            — recorder append, restore merge, reset/remove lifecycle
//   - ./persistence.ts         — `directory` (the journal root is `directory/sessions`)
//   - ./workers/io-protocol.ts — the append/flush/rewrite frames and their outcomes
//   - ./workers/io-worker.ts   — the thread that owns the fd in worker mode
//   - ./turn-projector.ts      — the fold that rebuilds compiled state from these records

import fs from 'node:fs';
import path from 'node:path';
import type { HarnessEvent } from '../harness';

// Sibling of `state.json`, so an operator can see both in one place. Named
// separately from the checkpoint's file/dir constants to keep the two lifecycles
// obvious in code.
export const HARNESS_JOURNAL_DIRECTORY = 'sessions';
export const HARNESS_JOURNAL_FILE = 'events.jsonl';
export const HARNESS_JOURNAL_VERSION = 1;

// One header line, the FIRST line of every journal. It exists so a reader can tell
// "an empty journal for a real session" apart from "a stray file", and so a future
// format change has a version to gate on (a mismatch is a problem, never a guess).
export type JournalHeaderRecord = {
    type: 'header';
    v: typeof HARNESS_JOURNAL_VERSION;
    sessionId: string;
    createdAt: number;
};

// One recorded event. `turnId` + `index` are the turn's append-only position, i.e.
// the SAME address a display step id carries (`DisplayStepDetailRef.stepId`), so a
// restored journal resolves a detail request to the identical byte.
export type JournalEventRecord = {
    type: 'event';
    v: typeof HARNESS_JOURNAL_VERSION;
    turnId: string;
    index: number;
    at: number;
    event: HarnessEvent;
};

export type JournalRecord = JournalHeaderRecord | JournalEventRecord;

export type JournalProblemKind = 'malformed' | 'version' | 'sequence' | 'shape';

// One structural problem found while reading. `tail: true` marks the crash-truncated
// last line (tolerated); every other problem is a real corruption report.
export type JournalProblem = {
    line: number;
    kind: JournalProblemKind;
    reason: string;
    tail: boolean;
};

export type JournalReadResult = {
    // Event records in file order, gaps/problems preserved for the caller to merge.
    events: JournalEventRecord[];
    header?: JournalHeaderRecord;
    problems: JournalProblem[];
    // True when the file exists but holds nothing but the header.
    empty: boolean;
    // True when there is no journal at all (a database written before R4). The
    // caller then folds the checkpoint's `turns[].events`, which every legacy
    // document already carries.
    missing: boolean;
    // True when the file's LAST line is incomplete (no terminating newline): a crash
    // mid-append. That one record is dropped and everything before it stands.
    truncatedTail: boolean;
};

// A journal failure with the absolute path, matching `HarnessPersistenceError`'s
// convention so an operator finds the file without guessing.
export class HarnessJournalError extends Error {
    constructor(
        readonly file: string,
        message: string
    ) {
        super(message);
        this.name = 'HarnessJournalError';
    }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// One event line. Kept a pure function so a test can assert the exact wire format
// without touching the filesystem.
export const journalLine = (record: JournalEventRecord | JournalHeaderRecord): string =>
    `${JSON.stringify(record)}\n`;

const isRecordObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// A parsed line must be a journal record of the supported version. Anything else is
// reported, not repaired: `event` must be an object because a null event would fold
// into the projector as a phantom step.
const parseLine = (line: string): { ok: true; record: JournalRecord } | { ok: false; reason: string } => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(line);
    } catch (error) {
        return { ok: false, reason: `not valid JSON: ${messageOf(error)}` };
    }

    if (!isRecordObject(parsed)) return { ok: false, reason: 'not a JSON object' };

    const { type, v } = parsed as { type?: unknown; v?: unknown };

    if (v !== HARNESS_JOURNAL_VERSION) {
        return {
            ok: false,
            reason: `unsupported journal version ${JSON.stringify(v)}; this server writes version ${HARNESS_JOURNAL_VERSION}`
        };
    }

    if (type === 'header') {
        const { sessionId, createdAt } = parsed as { sessionId?: unknown; createdAt?: unknown };

        if (typeof sessionId !== 'string' || sessionId.length === 0) {
            return { ok: false, reason: 'header sessionId is missing' };
        }
        if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
            return { ok: false, reason: 'header createdAt is missing' };
        }

        return { ok: true, record: { type: 'header', v: HARNESS_JOURNAL_VERSION, sessionId, createdAt } };
    }

    if (type === 'event') {
        const candidate = parsed as { turnId?: unknown; index?: unknown; at?: unknown; event?: unknown };

        if (typeof candidate.turnId !== 'string' || candidate.turnId.length === 0) {
            return { ok: false, reason: 'event turnId is missing' };
        }
        if (typeof candidate.index !== 'number' || !Number.isInteger(candidate.index) || candidate.index < 0) {
            return { ok: false, reason: 'event index is missing or not a non-negative integer' };
        }
        if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) {
            return { ok: false, reason: 'event at is missing' };
        }
        if (!isRecordObject(candidate.event) || typeof candidate.event.type !== 'string') {
            return { ok: false, reason: 'event payload is missing' };
        }

        return {
            ok: true,
            record: {
                type: 'event',
                v: HARNESS_JOURNAL_VERSION,
                turnId: candidate.turnId,
                index: candidate.index,
                at: candidate.at,
                event: candidate.event as HarnessEvent
            }
        };
    }

    return { ok: false, reason: `unknown journal record type ${JSON.stringify(type)}` };
};

// Owns one session's journal file. One instance per live session, held by the store
// (./sessions.ts), so appends need no path reconstruction and the write handle stays
// open for the session's life.
export class HarnessJournal {
    readonly directory: string;
    readonly file: string;

    // Held-open append handle. `fs.appendFileSync` opens and closes per call, which
    // for a token stream is one syscall pair per DELTA; a persistent fd plus
    // `flush()` at the boundaries that matter is the same durability story the
    // checkpoint already tells (an OS page-cache loss on a hard power failure can
    // drop unfsynced tail bytes; a process crash cannot).
    private handle: number | undefined;
    private lastError: string | undefined;
    private appendFailures = 0;
    private opened = false;

    constructor(root: string, sessionId: string) {
        this.directory = path.join(root, HARNESS_JOURNAL_DIRECTORY, sessionId);
        this.file = path.join(this.directory, HARNESS_JOURNAL_FILE);
    }

    // Last journal failure (open/append/flush/rewrite), or undefined after a
    // success. Mirrors `HarnessPersistence.lastWriteError` (./persistence.ts:1008):
    // best-effort writes still have to be EXPLAINABLE.
    get error(): string | undefined {
        return this.lastError;
    }

    get failures(): number {
        return this.appendFailures;
    }

    exists(): boolean {
        try {
            return fs.existsSync(this.file);
        } catch (error) {
            this.lastError = messageOf(error);
            return false;
        }
    }

    // Create the directory and write the header once. Never throws: a session whose
    // journal cannot be opened still runs, and `error` says why.
    open(): void {
        if (this.opened) return;

        try {
            fs.mkdirSync(this.directory, { recursive: true });

            if (!fs.existsSync(this.file)) {
                fs.writeFileSync(
                    this.file,
                    journalLine({ type: 'header', v: HARNESS_JOURNAL_VERSION, sessionId: path.basename(this.directory), createdAt: Date.now() }),
                    'utf8'
                );
            }

            this.opened = true;
            this.lastError = undefined;
        } catch (error) {
            this.lastError = messageOf(error);
            this.appendFailures += 1;
        }
    }

    // Append one event line. Returns false (and records the error) instead of
    // throwing, because the recorder calls this for every event of a live run.
    append(record: Omit<JournalEventRecord, 'type' | 'v'>): boolean {
        this.open();
        if (!this.opened) return false;

        const fd = this.ensureHandle();
        if (fd === undefined) return false;

        try {
            fs.writeSync(fd, journalLine({ type: 'event', v: HARNESS_JOURNAL_VERSION, ...record }));
            this.lastError = undefined;
            return true;
        } catch (error) {
            this.noteWrite(error);
            // Drop the handle so the next append reopens: a directory removed under
            // us must not wedge every later write.
            this.closeHandle();
            return false;
        }
    }

    // fsync the tail. Called at turn-terminal and at every checkpoint, i.e. exactly
    // where the existing code already treats durability as load-bearing.
    flush(): void {
        if (this.handle === undefined) return;

        try {
            fs.fsyncSync(this.handle);
            this.lastError = undefined;
        } catch (error) {
            this.noteWrite(error);
        }
    }

    // Read the whole journal. See the module header for the tolerance rules.
    read(): JournalReadResult {
        let text: string;

        try {
            if (!fs.existsSync(this.file)) {
                return { events: [], problems: [], empty: true, missing: true, truncatedTail: false };
            }

            text = fs.readFileSync(this.file, 'utf8');
        } catch (error) {
            this.lastError = messageOf(error);

            return {
                events: [],
                problems: [{ line: 0, kind: 'malformed', reason: messageOf(error), tail: false }],
                empty: true,
                missing: false,
                truncatedTail: false
            };
        }

        const events: JournalEventRecord[] = [];
        const problems: JournalProblem[] = [];
        let header: JournalHeaderRecord | undefined;
        // Per-turn expected next index. A gap is corruption (append order is the
        // write order), so it is reported rather than silently closed.
        const expected = new Map<string, number>();

        // A truncated tail is a record WITHOUT its terminating newline: the writer
        // died mid-append. `split` cannot see the difference (the empty tail segment is
        // dropped), so the newline check decides — and it decides BEFORE the loop,
        // because `tail` means "this is the tolerated crash tail", NOT "this happened
        // to be the last line". A gap or a shape problem on the last line is still real
        // corruption.
        const truncatedTail = text.length > 0 && !text.endsWith('\n');

        // Split on \n and drop only a TRAILING empty segment (every complete line ends
        // with a newline). A blank line in the middle stays and reports as corruption.
        const segments = text.split('\n');

        if (segments.length > 0 && segments[segments.length - 1] === '') segments.pop();

        for (let position = 0; position < segments.length; position += 1) {
            const line = segments[position];
            const last = position === segments.length - 1;

            if (line.length === 0) {
                problems.push({ line: position + 1, kind: 'malformed', reason: 'empty line', tail: false });
                continue;
            }

            const parsed = parseLine(line);

            if (!parsed.ok) {
                const tail = last && truncatedTail;

                problems.push({
                    line: position + 1,
                    kind: 'malformed',
                    reason: tail ? `${parsed.reason} (truncated tail)` : parsed.reason,
                    tail
                });
                continue;
            }

            if (parsed.record.type === 'header') {
                if (position !== 0) {
                    problems.push({ line: position + 1, kind: 'shape', reason: 'header is not the first line', tail: false });
                    continue;
                }

                header = parsed.record;
                continue;
            }

            if (header === undefined) {
                problems.push({ line: position + 1, kind: 'shape', reason: 'event before header', tail: false });
            }

            const record = parsed.record;
            const next = expected.get(record.turnId);

            if (next !== undefined && record.index !== next) {
                problems.push({
                    line: position + 1,
                    kind: 'sequence',
                    reason: `turn ${record.turnId} expected event index ${next}, found ${record.index}`,
                    // A gap is never a crash tail: appends are sequential, so a hole
                    // means a lost or rewritten line, and a reader must say so.
                    tail: false
                });
            }

            expected.set(record.turnId, record.index + 1);
            events.push(record);
        }

        return {
            events,
            ...(header === undefined ? {} : { header }),
            problems,
            empty: events.length === 0,
            missing: false,
            truncatedTail
        };
    }

    // Replace the whole log with `records` (atomic tmp + rename, the checkpoint's
    // rule). Used after a checkpoint proves the same events are durable in
    // `state.json`, and to repair a file whose tail was truncated.
    rewrite(records: readonly JournalEventRecord[]): void {
        this.open();
        if (!this.opened) return;

        this.closeHandle();

        const staging = `${this.file}.${process.pid}.${Date.now()}.tmp`;

        try {
            const payload =
                journalLine({
                    type: 'header',
                    v: HARNESS_JOURNAL_VERSION,
                    sessionId: path.basename(this.directory),
                    createdAt: Date.now()
                }) +
                records.map((record) => journalLine({ ...record, type: 'event', v: HARNESS_JOURNAL_VERSION })).join('');

            // fsync BEFORE the rename, the checkpoint's rule (./persistence.ts,
            // `writeHarnessDatabaseFile`): a rename can be durable while the bytes are
            // not, which would publish an empty or truncated log over the file the
            // caller just compacted. One syscall per compaction, and `rewrite` is now
            // able to answer 'durable' honestly (./workers/io-protocol.ts).
            const handle = fs.openSync(staging, 'w');

            try {
                fs.writeFileSync(handle, payload, 'utf8');
                fs.fsyncSync(handle);
            } finally {
                try {
                    fs.closeSync(handle);
                } catch {
                    // The handle is already unusable; the write error above is the
                    // reportable failure (same rule as the checkpoint's writer).
                }
            }

            fs.renameSync(staging, this.file);
            this.lastError = undefined;
        } catch (error) {
            this.noteWrite(error);

            try {
                if (fs.existsSync(staging)) fs.rmSync(staging, { force: true });
            } catch {
                // The staging file is the lesser problem; `error` is the report.
            }
        }
    }

    // Drop every recorded event (reset): the log starts over, and a stale event can
    // never be replayed onto a turn that no longer exists.
    truncate(): void {
        this.rewrite([]);
    }

    // Close the handle and remove the session's whole journal directory.
    remove(): void {
        this.closeHandle();
        this.opened = false;

        try {
            if (fs.existsSync(this.directory)) fs.rmSync(this.directory, { recursive: true, force: true });
            this.lastError = undefined;
        } catch (error) {
            this.noteWrite(error);
        }
    }

    close(): void {
        this.flush();
        this.closeHandle();
        this.opened = false;
    }

    private ensureHandle(): number | undefined {
        if (this.handle !== undefined) return this.handle;

        try {
            // 'a' never truncates and positions at the end, which is the whole point
            // of an append-only log (and is what makes a torn tail possible).
            this.handle = fs.openSync(this.file, 'a');
            this.lastError = undefined;
            return this.handle;
        } catch (error) {
            this.noteWrite(error);
            return undefined;
        }
    }

    private closeHandle(): void {
        if (this.handle === undefined) return;

        try {
            fs.closeSync(this.handle);
        } catch {
            // An unusable handle is already the reported failure.
        }

        this.handle = undefined;
    }

    private noteWrite(error: unknown): void {
        this.lastError = messageOf(error);
        this.appendFailures += 1;
    }
}

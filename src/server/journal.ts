// Per-step durable journal (R4).
//
// The checkpoint (./persistence.ts) is now a set of atomic replaces — `index.json`, one
// `sessions/<id>/session.json` per session and one
// `sessions/<id>/threads/<threadId>.json` per conversation; the v2 layout. It was one
// `state.json` document before the shard split, and the rules below are why a journal
// exists at all: rewriting the checkpoint for every harness event costs the edited
// session and its transcript (before the split: every session's every event), and text
// deltas were previously not durable at all until the terminal save. The journal is
// the other half of durability: an append-only, one-line-per-event log under
//
//     <databaseRoot>/harness/sessions/<sessionId>/events.jsonl
//
// which is O(1) per event and survives a crash. The checkpoint keeps everything else
// (core snapshot, roster, labels, queue) in the shards above, and THE JOURNAL ITSELF IS
// UNCHANGED by the split — same file, same directory, same lines — because that
// directory IS the v2 session directory (./persistence.ts:217 reuses
// `HARNESS_SESSION_DIRECTORY`), so a session's shards, its transcripts and its log stay
// in one footprint.
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
// THREE LINE KINDS, ONE FILE (F4, 2026-11-17):
//   - `header`   — line 1, the session's journal. Its `createdAt` is the log's BIRTH and
//                  is re-emitted unchanged by `rewrite` (a compaction replaces the body,
//                  it does not re-date the log).
//   - `event`    — one recorded step, addressed by `(turnId, index)`, the same address a
//                  display step id carries. `index` is the step's POSITION in
//                  `SessionTurn.events`, which is why the per-turn gap check below is a
//                  corruption report.
//   - `rollback` — the durable witness of an ABANDONED attempt (see
//                  `JournalRollbackRecord`): the events a resume spliced out of a turn,
//                  including that attempt's terminal `error` frame. It is EVIDENCE, never
//                  a step — the restore merge ignores it, so a rolled-back attempt is
//                  preserved without ever being re-projected.
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

// Sibling of the checkpoint header `index.json`, so an operator can see both in one
// place; under the v2 layout this IS the session's own directory, holding its
// `session.json`, its `threads/` shards and this file (./persistence.ts:217). Named
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

// F4 (2026-11-17): one ROLLBACK line — the durable witness of an abandoned attempt.
//
// WHY IT EXISTS. `requeueTurnInPlace` (./sessions.ts) rolls a failed/stopped attempt
// out of its turn record by splicing every event after the last `attempt_commit`
// (../sessions.ts `requeueTurnInPlace`) and then compacting the log. Compacting those
// indices used to mean the abandoned attempt left NO trace at all: its streamed bytes
// and — the part that made the live dump undebuggable — its terminal `error` frame were
// both gone, which is why `provider-timeout` appears 0 times in a `events.jsonl` whose
// run died of exactly that. This line is the "append an explicit journal record for the
// rollback" half of the fix: the dropped tail is written here BEFORE the truncation, so
// the evidence survives the very operation that resumed the turn.
//
// WHY IT IS ITS OWN RECORD TYPE AND NOT EXTRA EVENT LINES. The journal addresses a
// display step by `(turnId, index)`, and `index` is the event's POSITION in
// `SessionTurn.events` (./sessions.ts `mergeJournal` folds records onto a turn BY
// index). The resumed attempt re-uses the same turn id and re-numbers from 0, so the
// abandoned attempt's lines can live under one key: they would either collide with the
// new attempt's indices or trip the reader's per-turn gap check (./journal.ts `read`).
// A separate record type keeps the per-turn sequence contiguous, and the restore merge
// simply never folds it — this is DURABILITY, not re-folding: the rolled-back events are
// still not projected.
export type JournalRollbackEntry = {
    // The index this event held in the abandoned attempt's event list.
    index: number;
    at: number;
    event: HarnessEvent;
};

export type JournalRollbackRecord = {
    type: 'rollback';
    v: typeof HARNESS_JOURNAL_VERSION;
    turnId: string;
    at: number;
    // Where the abandoned tail began: the index of the last kept `attempt_commit`, or -1
    // when the attempt committed nothing and its whole event list was dropped.
    boundary: number;
    // Why the attempt was abandoned, in the server's own words (the run's failure text,
    // or the resume's reason). Optional because an older writer may not have one.
    reason?: string;
    // The dropped tail, in order, INCLUDING its terminal `error` frame.
    events: JournalRollbackEntry[];
};

export type JournalRecord = JournalHeaderRecord | JournalEventRecord | JournalRollbackRecord;

// What `rewrite` may publish: every record kind except the header, which it stamps itself.
//
// THE EVENT ARM IS TYPE-OPTIONAL ON PURPOSE. The compaction payload arrives from two callers
// with two shapes: `SessionStore.compactionRecordsOf` (./sessions.ts) hands over the store's own
// `JournalEventRecord`s (stamped), while the IO worker's `journal.rewrite` frame hands over
// `IoJournalRewriteRecord`s (./workers/io-protocol.ts:223-229) — the same fields WITHOUT the
// `type`/`v` stamps, because the writer adds them (the cast at ./workers/io-worker-loop.ts:254
// says so). The old writer stamped `type:'event'` unconditionally, which is why the type-less
// wire payload was legal; a discriminated union that demanded `type:'event'` would break that
// caller at compile time, and a branch on `record.type !== 'event'` (rather than on `'rollback'`)
// silently sent every worker compaction down the ROLLBACK arm — 0 events back from `read()`,
// which is the exact failure this shape fixes. So: an event record may omit its stamps, and
// ONLY an explicit `type:'rollback'` means a rollback line.
export type JournalEventRewriteRecord = Omit<JournalEventRecord, 'type' | 'v'> & {
    type?: 'event';
    v?: typeof HARNESS_JOURNAL_VERSION;
};

export type JournalRewriteRecord = JournalEventRewriteRecord | JournalRollbackRecord;

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
    // F4: rollback lines in file order (see `JournalRollbackRecord`). They are DELIBERATELY
    // separate from `events`: the restore merge folds `events` onto turn records by index,
    // and an abandoned attempt's tail must not be re-projected. `mergeJournal` reads these
    // only to keep them durable across a later compaction.
    rollbacks: JournalRollbackRecord[];
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
export const journalLine = (record: JournalRecord): string =>
    `${JSON.stringify(record)}\n`;

// One COMPACTION line: the record re-emitted by `rewrite` with the writer's own stamps.
// Written as an explicit branch per kind (rather than one spread) so the discriminated
// union stays narrow and a rollback line can never be flattened into an event line — the
// exact corruption the old forced `type:'event'` would have caused (see `rewrite`).
//
// THE TEST IS `=== 'rollback'`, NOT `=== 'event'`: the worker's rewrite payload carries no
// `type` at all (see `JournalEventRewriteRecord` above), so an event-test would classify those
// records as rollbacks and a worker-mode compaction would publish an event log whose every line
// the reader rejects. Anything that is not explicitly a rollback is an event line.
const rewriteLine = (record: JournalRewriteRecord): string =>
    record.type === 'rollback'
        ? journalLine({
              type: 'rollback',
              v: HARNESS_JOURNAL_VERSION,
              turnId: record.turnId,
              at: record.at,
              boundary: record.boundary,
              ...(record.reason === undefined ? {} : { reason: record.reason }),
              events: record.events
          })
        : journalLine({
              type: 'event',
              v: HARNESS_JOURNAL_VERSION,
              turnId: record.turnId,
              index: record.index,
              at: record.at,
              event: record.event
          });

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

    if (type === 'rollback') {
        const candidate = parsed as {
            turnId?: unknown;
            at?: unknown;
            boundary?: unknown;
            reason?: unknown;
            events?: unknown;
        };

        if (typeof candidate.turnId !== 'string' || candidate.turnId.length === 0) {
            return { ok: false, reason: 'rollback turnId is missing' };
        }
        if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) {
            return { ok: false, reason: 'rollback at is missing' };
        }
        // -1 is the honest "the attempt committed nothing" boundary; any other value is
        // the index of the last kept event, so a non-negative integer.
        if (typeof candidate.boundary !== 'number' || !Number.isInteger(candidate.boundary) || candidate.boundary < -1) {
            return { ok: false, reason: 'rollback boundary is missing or not an integer >= -1' };
        }
        if (candidate.reason !== undefined && typeof candidate.reason !== 'string') {
            return { ok: false, reason: 'rollback reason is not a string' };
        }
        if (!Array.isArray(candidate.events)) {
            return { ok: false, reason: 'rollback events is missing or not an array' };
        }

        const events: JournalRollbackEntry[] = [];

        for (const entry of candidate.events as unknown[]) {
            if (!isRecordObject(entry)) {
                return { ok: false, reason: 'rollback event entry is not a JSON object' };
            }

            const { index, at, event } = entry as { index?: unknown; at?: unknown; event?: unknown };

            if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
                return { ok: false, reason: 'rollback event index is missing or not a non-negative integer' };
            }
            if (typeof at !== 'number' || !Number.isFinite(at)) {
                return { ok: false, reason: 'rollback event at is missing' };
            }
            // Same rule as an event line: a null event would fold as a phantom step, and a
            // rollback entry with no readable type is not an event we can show an operator.
            if (!isRecordObject(event) || typeof event.type !== 'string') {
                return { ok: false, reason: 'rollback event payload is missing' };
            }

            events.push({ index, at, event: event as HarnessEvent });
        }

        return {
            ok: true,
            record: {
                type: 'rollback',
                v: HARNESS_JOURNAL_VERSION,
                turnId: candidate.turnId,
                at: candidate.at,
                boundary: candidate.boundary,
                ...(typeof candidate.reason === 'string' ? { reason: candidate.reason } : {}),
                events
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
    // F4: the header's original `createdAt`, captured the first time this instance opens the
    // file (see `open()`), and re-emitted by `rewrite()` so a compaction never re-dates the log.
    private headerCreatedAt: number | undefined;

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
                const createdAt = Date.now();

                fs.writeFileSync(
                    this.file,
                    journalLine({ type: 'header', v: HARNESS_JOURNAL_VERSION, sessionId: path.basename(this.directory), createdAt }),
                    'utf8'
                );
                this.headerCreatedAt = createdAt;
            } else {
                // F4 (2026-11-17): A COMPACTION MUST NOT RE-DATE THE LOG. `rewrite` used to
                // stamp `createdAt: Date.now()`, so the one file whose whole purpose is being
                // the durable per-step record of a session claimed to have been BORN the
                // instant its first resume compacted it (the live dump showed a journal whose
                // session started days earlier). The original value is read back off the first
                // line here and reused by `rewrite`; a log with no readable header falls back
                // to "now", which is what an unreadable header honestly means for a rewrite.
                this.headerCreatedAt = this.readHeaderCreatedAt() ?? Date.now();
            }

            this.opened = true;
            this.lastError = undefined;
        } catch (error) {
            this.lastError = messageOf(error);
            this.appendFailures += 1;
        }
    }

    // The instant this journal's header says it was created, or undefined until the
    // instance has opened the file. `rewrite` uses it so the header survives a compaction.
    get createdAt(): number | undefined {
        return this.headerCreatedAt;
    }

    // The header's `createdAt`, read from ONLY the first bytes of the file. A journal can be
    // megabytes of token deltas, so a compaction must not pay a full read to keep a stamp:
    // 4 KiB covers the header line of any real session (the line is a few dozen bytes), and
    // anything the bounded read cannot parse is reported as "no header" rather than guessed.
    private readHeaderCreatedAt(): number | undefined {
        let handle: number | undefined;

        try {
            handle = fs.openSync(this.file, 'r');

            const buffer = Buffer.alloc(4096);
            const read = fs.readSync(handle, buffer, 0, 4096, 0);

            if (read <= 0) return undefined;

            const first = buffer
                .subarray(0, read)
                .toString('utf8')
                .split('\n')[0];

            if (first === undefined || first.length === 0) return undefined;

            const parsed = parseLine(first);

            if (!parsed.ok || parsed.record.type !== 'header') return undefined;

            return parsed.record.createdAt;
        } catch {
            // Best-effort by design: the caller falls back to "now", and `open()` already
            // reports a directory/file it cannot touch through `lastError`.
            return undefined;
        } finally {
            if (handle !== undefined) {
                try {
                    fs.closeSync(handle);
                } catch {
                    // The read already happened (or failed); a second error adds nothing.
                }
            }
        }
    }

    // Append one event line. Returns false (and records the error) instead of
    // throwing, because the recorder calls this for every event of a live run.
    append(record: Omit<JournalEventRecord, 'type' | 'v'>): boolean {
        return this.appendLine(journalLine({ type: 'event', v: HARNESS_JOURNAL_VERSION, ...record }));
    }

    // F4: append one ROLLBACK line (see `JournalRollbackRecord`). Same best-effort
    // contract as `append` — a full disk must never change a run's outcome, and
    // `error`/`failures` are how the store reports the loss — but written ONCE per
    // abandonment, by `requeueTurnInPlace`, BEFORE the events it preserves are spliced
    // out of the turn record. `sessions.ts` keeps the same payload in the session shard,
    // which is the copy that survives a `ioExecution: 'worker'` compaction (the worker's
    // rewrite frame carries event records only, ./workers/io-protocol.ts
    // `IoJournalRewriteRecord`).
    appendRollback(record: Omit<JournalRollbackRecord, 'type' | 'v'>): boolean {
        return this.appendLine(journalLine({ type: 'rollback', v: HARNESS_JOURNAL_VERSION, ...record }));
    }

    // The one write path both appenders share: held-fd `writeSync`, best-effort, with the
    // handle dropped on failure so a directory removed under us cannot wedge later writes.
    private appendLine(line: string): boolean {
        this.open();
        if (!this.opened) return false;

        const fd = this.ensureHandle();
        if (fd === undefined) return false;

        try {
            fs.writeSync(fd, line);
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
                return { events: [], rollbacks: [], problems: [], empty: true, missing: true, truncatedTail: false };
            }

            text = fs.readFileSync(this.file, 'utf8');
        } catch (error) {
            this.lastError = messageOf(error);

            return {
                events: [],
                rollbacks: [],
                problems: [{ line: 0, kind: 'malformed', reason: messageOf(error), tail: false }],
                empty: true,
                missing: false,
                truncatedTail: false
            };
        }

        const events: JournalEventRecord[] = [];
        const rollbacks: JournalRollbackRecord[] = [];
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

            // F4: a rollback line is EVIDENCE, not a step. It never joins the per-turn index
            // sequence (its indices belong to an attempt that no longer exists) and it is
            // never folded onto a turn record, so it cannot create a gap report and cannot
            // resurrect a rolled-back step on the next start.
            if (parsed.record.type === 'rollback') {
                if (header === undefined) {
                    problems.push({ line: position + 1, kind: 'shape', reason: 'rollback before header', tail: false });
                }

                rollbacks.push(parsed.record);
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
            rollbacks,
            ...(header === undefined ? {} : { header }),
            problems,
            // "Nothing but the header" has to account for a rollback line too: a journal
            // holding only the evidence of an abandoned attempt is NOT an empty log.
            empty: events.length === 0 && rollbacks.length === 0,
            missing: false,
            truncatedTail
        };
    }

    // Replace the whole log with `records` (atomic tmp + rename, the checkpoint's
    // rule). Used after a checkpoint proves the same events are durable in the
    // session's `session.json` shard, and to repair a file whose tail was truncated.
    //
    // F4 (2026-11-17): the payload widened from `JournalEventRecord[]` to
    // `JournalRewriteRecord[]` — a compaction now re-emits the session's ROLLBACK lines
    // alongside the live event records (./sessions.ts `compactJournal` passes both). Without
    // that, a resume would preserve the abandoned attempt once and then erase it on the NEXT
    // resume of any turn in the session, which is the same evidence loss this fix exists to
    // stop. Each record keeps its OWN `type`; the old code forced `'event'` on every line,
    // which would have rewritten a rollback line into a bogus step.
    rewrite(records: readonly JournalRewriteRecord[]): void {
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
                    // The captured original (see `open()`), never `Date.now()`: the rewrite
                    // replaces the log's BODY, not the log's birth.
                    createdAt: this.headerCreatedAt ?? Date.now()
                }) +
                records.map((record) => rewriteLine(record)).join('');

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
        // The file is gone, and with it its birth stamp: a journal written again after
        // this really IS a new log (`open()` writes a fresh header in that case).
        this.headerCreatedAt = undefined;

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

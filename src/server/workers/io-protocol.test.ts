// The IO worker wire protocol (v2): the frame validators, the durability outcome table,
// the SHARD ordering rule, and the error-report shape the two boundaries share.
//
// These tests pin the rules the durability contract rests on, exactly:
//   - a frame that is not structurally valid is REFUSED at the boundary that receives it
//     (a silently ignored frame later looks like a request that never returned),
//   - a worker may only answer 'durable' or 'written' ('superseded' is a coordinator-side
//     notion, so it must never appear in a reply),
//   - the failure report keeps the inline writer's message, so a 500 in worker mode reads
//     identical to a 500 inline (./io-client.test.ts asserts that parity end to end),
//   - R5: one commit is SEVERAL shard files, so the ordering rule (`IO_SHARD_ORDER`,
//     `orderIoShardUnits`) and the per-path key (`ioShardPath`) are the durability
//     contract, and a unit whose `kind` disagrees with its target is refused BEFORE any
//     rename can put a thread payload over `index.json`.

import { describe, expect, it } from 'vitest';
import {
    IO_DURABLE_OUTCOMES,
    IO_HANDSHAKE_MS,
    IO_MAX_FRAME_BYTES,
    IO_OPERATION_KINDS,
    IO_PROTOCOL_VERSION,
    IO_SHARD_KINDS,
    IO_SHARD_ORDER,
    IO_WORKER_BOOT_KEY,
    createIoCallIds,
    describeIoFrame,
    ioErrorReportOf,
    ioJournalKey,
    ioShardPath,
    isIoCheckpointTarget,
    isIoCommand,
    isIoJournalRecord,
    isIoJournalTarget,
    isIoReply,
    isIoShardTarget,
    isIoShardUnit,
    isTransferableIoFrame,
    orderIoShardUnits,
    type IoCheckpointTarget,
    type IoJournalTarget,
    type IoShardTarget
} from './io-protocol';

const indexTarget: IoCheckpointTarget = { directory: '/db/harness', file: '/db/harness/index.json' };
const journal: IoJournalTarget = { root: '/db/harness', sessionId: 'session-1' };

// One `shard.save` frame, spelled the way the client posts it (v2): the target carries
// kind + the two halves of the destination, the unit is A1's `HarnessSessionShardUnit`
// shape (../persistence.ts), and `savedAt` is the coordinator's stamp.
const shardTarget: IoShardTarget = {
    kind: 'session',
    directory: '/db/harness/sessions/session-1',
    file: '/db/harness/sessions/session-1/session.json'
};

const save = (over: Record<string, unknown> = {}) => ({
    kind: 'shard.save',
    callId: 1,
    target: shardTarget,
    unit: { kind: 'session', directory: '/db/harness/sessions/session-1', sessionId: 'session-1', record: { id: 'session-1' } },
    savedAt: 1_700_000_000_000,
    ...over
});

describe('protocol constants', () => {
    it('pins the version, boot key, handshake bound and frame bound', () => {
        // These four are the deployment surface: a stale bundle gates on `version` (R5
        // bumped it to 2: `checkpoint.save` is gone, replaced by `shard.save`; the parity
        // pass bumps it to 3: the operation set grew `shard.erase`, which a version-2 worker
        // has no handler for and would answer with a `fault`), the boot marker decides
        // whether the entry self-starts, and the two bounds are the numbers an operator tunes
        // when a database grows. Under R5 the frame bound applies to ONE SHARD, which is the
        // whole point of sharding: the bound that a 110 MB single-document database kept
        // tripping is now measured per conversation.
        expect(IO_PROTOCOL_VERSION).toBe(3);
        expect(IO_WORKER_BOOT_KEY).toBe('harnessIoWorker');
        expect(IO_HANDSHAKE_MS).toBe(60_000);
        expect(IO_MAX_FRAME_BYTES).toBe(64 * 1024 * 1024);
    });

    it('names the durability outcome of every operation exactly', () => {
        // The R4 table, updated for R5: which answers mean "stable storage" and which only
        // mean "the OS has it". `shard.save` answers 'durable' FOR ITS OWN FILE - a
        // resolved shard is one renamed file, never a composite claim. A reviewer checks
        // this against the durability requirement, and a test is the only place it can be
        // checked without reading the writer.
        //
        // `shard.erase` is 'durable' and that is NOT a stronger claim than inline makes: the
        // coordinator posts the frame UNAWAITED, so no receipt and no API response ever carries
        // it (../workers/io-client.ts `postShardErase`). A leftover file whose unlink failed
        // costs disk, exactly as it does inline, where the collector swallows the failure.
        expect(IO_DURABLE_OUTCOMES).toEqual({
            'shard.save': 'durable',
            'shard.erase': 'durable',
            'journal.open': 'written',
            'journal.append': 'written',
            'journal.flush': 'durable',
            'journal.rewrite': 'durable',
            'journal.truncate': 'durable',
            'journal.remove': 'durable',
            'journal.close': 'durable'
        });
    });

    it('closed the operation set: shard.save replaced checkpoint.save, one whole-document save is gone', () => {
        // R5 deleted the whole-document save rather than keeping it alongside: a second
        // path that still wrote one `state.json` would be a contradicting storage layout
        // in the same directory. This exact-list assertion is what makes "gone, not
        // deprecated" checkable. `shard.erase` is the removal leg the same layout needs —
        // without it a worker-mode commit could not stop naming a file at all.
        expect(IO_OPERATION_KINDS).toEqual([
            'shard.save',
            'shard.erase',
            'journal.open',
            'journal.append',
            'journal.flush',
            'journal.rewrite',
            'journal.truncate',
            'journal.remove',
            'journal.close'
        ]);
    });

    it('pins the shard kinds and THE commit order the reader depends on', () => {
        // The reader starts at `index.json` and follows references down, so every file a
        // published file REFERENCES must already be on disk: threads first, then the
        // session file that lists them, then the index. These two spellings of the rule
        // are the contract; `orderIoShardUnits` below proves the client cannot quietly
        // reorder.
        expect(IO_SHARD_KINDS).toEqual(['index', 'session', 'thread']);
        expect(IO_SHARD_ORDER).toEqual({ thread: 0, session: 1, index: 2 });
    });
});

describe('isIoCommand', () => {
    it('accepts the two control frames and every operation shape', () => {
        expect(isIoCommand({ kind: 'hello', callId: 0 })).toBe(true);
        expect(isIoCommand({ kind: 'shutdown', callId: 7, reason: 'closing' })).toBe(true);
        expect(isIoCommand(save())).toBe(true);
        expect(isIoCommand({ kind: 'journal.open', callId: 2, target: journal })).toBe(true);
        expect(isIoCommand({ kind: 'journal.append', callId: 3, target: journal, record: { turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: 'x' } } })).toBe(true);
        expect(isIoCommand({ kind: 'journal.flush', callId: 4, target: journal })).toBe(true);
        expect(isIoCommand({ kind: 'journal.rewrite', callId: 5, target: journal, records: [] })).toBe(true);
        expect(isIoCommand({ kind: 'journal.truncate', callId: 6, target: journal })).toBe(true);
        expect(isIoCommand({ kind: 'journal.remove', callId: 8, target: journal })).toBe(true);
        expect(isIoCommand({ kind: 'journal.close', callId: 9, target: journal })).toBe(true);
    });

    it('refuses a frame whose kind, callId or target is wrong', () => {
        // Each refusal is a distinct mistake a hand-rolled or mixed-version caller can
        // make, and each one would otherwise become a write to the wrong place.
        expect(isIoCommand({ kind: 'nonsense', callId: 1, target: indexTarget })).toBe(false);
        expect(isIoCommand({ kind: 'shard.save', callId: 0, target: shardTarget })).toBe(false);
        expect(isIoCommand({ kind: 'shard.save', callId: 1.5, target: shardTarget })).toBe(false);
        expect(isIoCommand({ kind: 'hello', callId: 1 })).toBe(false);
        expect(isIoCommand({ kind: 'shutdown', callId: 0 })).toBe(false);
        expect(isIoCommand(save({ target: undefined }))).toBe(false);
        expect(isIoCommand(save({ target: { kind: 'session', directory: '', file: '/x/session.json' } }))).toBe(false);
        expect(isIoCommand(save({ savedAt: Number.NaN }))).toBe(false);
        expect(isIoCommand(save({ unit: null }))).toBe(false);
        expect(isIoCommand(save({ unit: 'not-an-object' }))).toBe(false);
        expect(isIoCommand(null)).toBe(false);
        expect(isIoCommand('shard.save')).toBe(false);
    });

    it('refuses a shard frame whose unit and target disagree about WHAT the file is', () => {
        // THE self-consistency rule of v2: `kind` is the only field this layer reads off a
        // unit, and it reads it to prove the frame describes one file. A thread payload
        // aimed at `index.json` would otherwise be renamed over the header and nothing
        // downstream could tell until a reader choked.
        expect(isIoCommand(save({ unit: { kind: 'thread', directory: shardTarget.directory, sessionId: 'session-1', id: 'thread-1', messages: [] } }))).toBe(false);
        // A target with a kind the layout does not know (or with no kind at all) is the
        // mixed-checkout case: client and worker built from different layouts.
        expect(isIoCommand(save({ target: { kind: 'document', directory: '/db/harness', file: '/db/harness/state.json' } }))).toBe(false);
        expect(isIoCommand(save({ target: { directory: '/db/harness', file: '/db/harness/index.json' } }))).toBe(false);
        // An unknown unit kind cannot be ordered, so it cannot be committed.
        expect(isIoCommand(save({ unit: { kind: 'state', directory: shardTarget.directory } }))).toBe(false);
    });

    it('refuses a journal frame that cannot address one session log', () => {
        expect(isIoCommand({ kind: 'journal.append', callId: 1, target: { root: '', sessionId: 's' }, record: { turnId: 't', index: 0, at: 0, event: {} } })).toBe(false);
        expect(isIoCommand({ kind: 'journal.append', callId: 1, target: { root: '/r', sessionId: '' }, record: { turnId: 't', index: 0, at: 0, event: {} } })).toBe(false);
        expect(isIoCommand({ kind: 'journal.flush', callId: 1 })).toBe(false);
        expect(isIoCommand({ kind: 'journal.rewrite', callId: 1, target: journal, records: undefined })).toBe(false);
    });

    it('refuses an append record that the reader would later reject', () => {
        const record = (over: Record<string, unknown> = {}) => ({ turnId: 't1', index: 0, at: 1, event: { type: 'text' }, ...over });

        expect(isIoJournalRecord(record())).toBe(true);
        expect(isIoJournalRecord(record({ turnId: '' }))).toBe(false);
        expect(isIoJournalRecord(record({ index: -1 }))).toBe(false);
        expect(isIoJournalRecord(record({ index: 1.5 }))).toBe(false);
        expect(isIoJournalRecord(record({ at: Number.NaN }))).toBe(false);
        // A null event would fold into the projector as a phantom step
        // (../journal.ts enforces the same rule on the read side).
        expect(isIoJournalRecord(record({ event: null }))).toBe(false);
        expect(isIoJournalRecord(record({ event: 'text' }))).toBe(false);
        expect(isIoCommand({ kind: 'journal.append', callId: 1, target: journal, record: record({ index: -1 }) })).toBe(false);
    });
});

describe('shard.erase frames', () => {
    // The removal frame the parity pass added. Its shape carries the LAYOUT twice and means it
    // once: `files`/`trees` are absolute paths the COORDINATOR derived through persistence.ts, and
    // `target` names the subject for the per-path statistics and the failure report. The worker
    // reads only the path lists, which is what keeps it as layout-agnostic as `shard.save`.
    const erase = (over: Record<string, unknown> = {}) => ({
        kind: 'shard.erase',
        callId: 11,
        target: shardTarget,
        files: ['/db/harness/sessions/session-1/session.json'],
        trees: ['/db/harness/sessions/session-1/threads'],
        ...over
    });

    it('accepts a removal that names at least one shard file or tree', () => {
        expect(isIoCommand(erase())).toBe(true);
        // A cap-retired transcript erases FILES and no tree; a whole vanished session erases both.
        expect(isIoCommand(erase({ trees: [] }))).toBe(true);
        expect(isIoCommand(erase({ files: [], trees: ['/db/harness/sessions/session-1/threads'] }))).toBe(true);
    });

    it('refuses a removal that cannot name what it removes', () => {
        // A frame that removes nothing still answers 'durable', so accepting one would let a
        // coordinator bug (an empty plan) report a cleanup that never happened.
        expect(isIoCommand(erase({ files: [], trees: [] }))).toBe(false);
        expect(isIoCommand(erase({ files: undefined }))).toBe(false);
        expect(isIoCommand(erase({ trees: undefined }))).toBe(false);
        expect(isIoCommand(erase({ files: 'not-an-array' }))).toBe(false);
        // An empty path is not a path: the failure report would have no subject, and removing ''
        // is an exception rather than a removal.
        expect(isIoCommand(erase({ files: [''] }))).toBe(false);
        expect(isIoCommand(erase({ trees: [null] }))).toBe(false);
        expect(isIoCommand(erase({ target: undefined }))).toBe(false);
        expect(isIoCommand(erase({ target: { kind: 'session', directory: '', file: '/x/session.json' } }))).toBe(false);
        expect(isIoCommand({ kind: 'shard.erase', callId: 0, target: shardTarget, files: ['/x/session.json'], trees: [] })).toBe(false);
        // A removal carries NO payload, so the frame bound that every `shard.save` measures cannot
        // apply — and the kind still has to be one the worker knows.
        expect(isIoCommand({ kind: 'shard.erasex', callId: 11, target: shardTarget, files: ['/x'], trees: [] })).toBe(false);
    });
});

describe('isIoReply', () => {
    it('accepts every legal answer the worker produces', () => {
        expect(isIoReply({ kind: 'hello', callId: 0, version: IO_PROTOCOL_VERSION, ok: true })).toBe(true);
        expect(isIoReply({ kind: 'bye', callId: 3, ok: true, drained: 2 })).toBe(true);
        expect(isIoReply({ kind: 'result', callId: 3, ok: true, outcome: 'durable', durationMs: 1.5, bytes: 12 })).toBe(true);
        expect(isIoReply({ kind: 'result', callId: 4, ok: true, outcome: 'written', durationMs: 0.25 })).toBe(true);
        // The skip flag is ADDITIVE: a version-3 worker may say "these bytes were already on disk"
        // on an otherwise ordinary `durable` answer, and a client must not treat it as an
        // unparseable reply (an unreadable reply is counted `late`, and the operation would hang).
        // The outcome is unchanged either way, which is what keeps the flag from being a new
        // durability state.
        expect(isIoReply({ kind: 'result', callId: 3, ok: true, outcome: 'durable', durationMs: 1.5, bytes: 12, skipped: true })).toBe(true);
        expect(isIoReply({ kind: 'result', callId: 3, ok: true, outcome: 'durable', durationMs: 1.5, skipped: false })).toBe(true);
        expect(isIoReply({ kind: 'failure', callId: 5, ok: false, durationMs: 0.5, error: { message: 'ENOENT', code: 'ENOENT', path: '/x' } })).toBe(true);
        // R5: a size refusal names ONE shard and still carries the measurement, so the
        // client's per-path guard learns the true size without another commit.
        expect(isIoReply({ kind: 'failure', callId: 5, ok: false, durationMs: 0.5, bytes: 70_000_000, error: { message: 'too big', code: 'frame-too-large', path: '/db/harness/sessions/session-1/threads/thread-1.json' } })).toBe(true);
        expect(isIoReply({ kind: 'fault', message: 'Unrecognized IO frame: undefined.' })).toBe(true);
        expect(isIoReply({ kind: 'fault', callId: 6, message: 'bad frame' })).toBe(true);
    });

    it('refuses the answers that would make durability ambiguous', () => {
        // 'superseded' is the COORDINATOR's word for a dropped queued shard; if a worker
        // ever answered with it, the client's receipt type would lie.
        expect(isIoReply({ kind: 'result', callId: 1, ok: true, outcome: 'superseded', durationMs: 1 })).toBe(false);
        expect(isIoReply({ kind: 'result', callId: 1, ok: true, outcome: 'maybe', durationMs: 1 })).toBe(false);
        expect(isIoReply({ kind: 'result', callId: 1, ok: true, outcome: 'durable' })).toBe(false);
        expect(isIoReply({ kind: 'result', callId: 0, ok: true, outcome: 'durable', durationMs: 1 })).toBe(false);
        expect(isIoReply({ kind: 'failure', callId: 1, ok: false, error: { code: 'ENOENT' } })).toBe(false);
        expect(isIoReply({ kind: 'failure', callId: 1, ok: false, error: 'ENOENT' })).toBe(false);
        expect(isIoReply({ kind: 'failure', callId: 1, ok: true, durationMs: 0.5, error: { message: 'ENOENT', code: 'ENOENT' } })).toBe(false);
        expect(isIoReply({ kind: 'hello', callId: 0, ok: true })).toBe(false);
        expect(isIoReply({ kind: 'bye', callId: 0, ok: true, drained: 0 })).toBe(false);
        expect(isIoReply({ kind: 'fault', message: 7 })).toBe(false);
        expect(isIoReply({ kind: 'unknown', callId: 1, ok: true })).toBe(false);
        expect(isIoReply(undefined)).toBe(false);
    });
});

describe('target, unit and key helpers', () => {
    it('validates targets by the fields the writer indexes into', () => {
        expect(isIoCheckpointTarget(indexTarget)).toBe(true);
        expect(isIoCheckpointTarget({ directory: '/db/harness' })).toBe(false);
        expect(isIoCheckpointTarget({ directory: '/db/harness', file: '' })).toBe(false);
        expect(isIoJournalTarget(journal)).toBe(true);
        expect(isIoJournalTarget({ root: '/db/harness' })).toBe(false);
    });

    it('validates a shard target by its kind, and a shard unit by NOTHING but its kind', () => {
        expect(isIoShardTarget(shardTarget)).toBe(true);
        expect(isIoShardTarget({ ...shardTarget, kind: 'ledger' })).toBe(false);
        expect(isIoShardTarget(indexTarget)).toBe(false);

        // Deliberately shallow on the unit: a deeper check would duplicate the persistence
        // layer's format knowledge (../persistence.ts owns it) into the wire protocol.
        expect(isIoShardUnit({ kind: 'index', directory: '/db/harness', document: {} })).toBe(true);
        expect(isIoShardUnit({ kind: 'thread' })).toBe(true);
        expect(isIoShardUnit({ directory: '/db/harness' })).toBe(false);
        expect(isIoShardUnit(null)).toBe(false);
    });

    it('keys coalescing on the shard FILE, so supersession is provably per-destination', () => {
        // Two units supersede each other EXACTLY when they would have overwritten each
        // other - which is what "same file" means, and the only key that honest.
        expect(ioShardPath(shardTarget)).toBe('/db/harness/sessions/session-1/session.json');
        expect(ioShardPath({ kind: 'thread', directory: '/db/harness/sessions/session-1/threads', file: '/db/harness/sessions/session-1/threads/thread-1.json' }))
            .toBe('/db/harness/sessions/session-1/threads/thread-1.json');
        expect(ioShardPath({ kind: 'index', directory: '/db/harness', file: '/db/harness/index.json' }))
            .toBe('/db/harness/index.json');
    });

    it('orders a commit the way the disk must see it, stably, dropping nothing', () => {
        // The R5 acceptance test for the ordering rule: threads before the session file
        // that lists them, that before the index. STABLE within a kind, because "the order
        // the caller built the units in is the order the disk sees" is the rule the whole
        // queue rests on - and the caller's list is exactly the worker's list.
        const entry = (label: string, kind: IoShardTarget['kind'], file: string) => ({ label, target: { kind, directory: '/db/harness', file } });
        const unordered = [
            entry('index', 'index', '/db/harness/index.json'),
            entry('session-2', 'session', '/db/harness/sessions/s2/session.json'),
            entry('thread-b', 'thread', '/db/harness/sessions/s1/threads/thread-2.json'),
            entry('session-1', 'session', '/db/harness/sessions/s1/session.json'),
            entry('thread-a', 'thread', '/db/harness/sessions/s1/threads/thread-1.json')
        ];

        expect(orderIoShardUnits(unordered).map((unit) => unit.label)).toEqual([
            'thread-b',
            'thread-a',
            'session-2',
            'session-1',
            'index'
        ]);

        // The input is not mutated, and the function never invents or drops units.
        expect(unordered.map((unit) => unit.label)).toEqual(['index', 'session-2', 'thread-b', 'session-1', 'thread-a']);
    });

    it('derives one stable key per journal handle, and a distinct one per session', () => {
        expect(ioJournalKey(journal)).toBe('/db/harness\u0000session-1');
        expect(ioJournalKey({ root: '/db/harness', sessionId: 'session-2' })).toBe('/db/harness\u0000session-2');
        expect(ioJournalKey({ root: '/other', sessionId: 'session-1' })).not.toBe(ioJournalKey(journal));
    });

    it('names an offending frame without echoing a whole shard payload', () => {
        expect(describeIoFrame(save())).toBe('kind="shard.save" callId=1');
        expect(describeIoFrame(null)).toBe('object');
        expect(describeIoFrame('x')).toBe('string');
        expect(describeIoFrame({})).toBe('kind=undefined callId=undefined');
    });

    it('counts call ids from 1 so 0 means a control frame', () => {
        const next = createIoCallIds();

        expect([next(), next(), next()]).toEqual([1, 2, 3]);
    });
});

describe('failure reports', () => {
    it('keeps the thrown message and reaches through the wrapper for the errno', () => {
        // The wrapper message is what the inline path puts in a 500; the cause carries
        // the errno. A report must give both, or the two write modes report differently.
        // R5: the subject is ONE shard file - `ioErrorReportOf` reads whatever `file` the
        // thrown error names, which for a shard failure is the shard's own path.
        const raw = Object.assign(new Error("ENOENT: no such file or directory, rename 'a' -> 'b'"), { code: 'ENOENT', path: 'a' });
        const wrapper = new Error("/db/harness/sessions/session-1/session.json: Could not write the harness database: ENOENT: no such file or directory, rename 'a' -> 'b'");

        (wrapper as Error & { cause?: unknown }).cause = raw;
        (wrapper as Error & { file?: unknown }).file = '/db/harness/sessions/session-1/session.json';

        expect(ioErrorReportOf(wrapper)).toEqual({
            message: "/db/harness/sessions/session-1/session.json: Could not write the harness database: ENOENT: no such file or directory, rename 'a' -> 'b'",
            code: 'ENOENT',
            path: '/db/harness/sessions/session-1/session.json',
            // The raw failure travels separately, because the inline writer's
            // `lastWriteError` channel reports THAT text and a 500 reports the wrapper.
            cause: "ENOENT: no such file or directory, rename 'a' -> 'b'"
        });
    });

    it('falls back to a named code and no path when there is nothing to reach through', () => {
        expect(ioErrorReportOf(new Error('boom'))).toEqual({ message: 'boom', code: 'io-exception' });
        expect(ioErrorReportOf(new Error('boom'), 'fs')).toEqual({ message: 'boom', code: 'fs' });
        expect(ioErrorReportOf('plain string')).toEqual({ message: 'plain string', code: 'io-exception' });
    });
});

describe('frame transferability', () => {
    it('accepts a real shard frame and refuses a value that cannot cross a port', () => {
        // Not used per frame in the hot path (that would double the clone cost -
        // see ./io-client.ts `post`), but it is the pre-flight a caller can run once
        // before committing to a unit shape.
        expect(isTransferableIoFrame(save())).toBe(true);
        expect(isTransferableIoFrame({ unit: () => 1 })).toBe(false);
        expect(isTransferableIoFrame({ unit: Symbol('s') })).toBe(false);
    });
});

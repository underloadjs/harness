// The IO worker wire protocol: the frame validators, the durability outcome table, and
// the error-report shape the two boundaries share.
//
// These tests pin the rules the durability contract rests on, exactly:
//   - a frame that is not structurally valid is REFUSED at the boundary that receives it
//     (a silently ignored frame later looks like a request that never returned),
//   - a worker may only answer 'durable' or 'written' ('superseded' is a coordinator-side
//     notion, so it must never appear in a reply),
//   - the failure report keeps the inline writer's message, so a 500 in worker mode reads
//     identical to a 500 inline (./io-client.test.ts asserts that parity end to end).

import { describe, expect, it } from 'vitest';
import {
    IO_DURABLE_OUTCOMES,
    IO_HANDSHAKE_MS,
    IO_MAX_FRAME_BYTES,
    IO_PROTOCOL_VERSION,
    IO_WORKER_BOOT_KEY,
    createIoCallIds,
    describeIoFrame,
    ioErrorReportOf,
    ioJournalKey,
    isIoCheckpointTarget,
    isIoCommand,
    isIoJournalRecord,
    isIoJournalTarget,
    isIoReply,
    isTransferableIoFrame,
    type IoCheckpointTarget,
    type IoJournalTarget
} from './io-protocol';

const target: IoCheckpointTarget = { directory: '/db/harness', file: '/db/harness/state.json' };
const journal: IoJournalTarget = { root: '/db/harness', sessionId: 'session-1' };

const save = (over: Record<string, unknown> = {}) => ({
    kind: 'checkpoint.save',
    callId: 1,
    target,
    document: { version: 1, savedAt: 1, registry: [], sessions: [] },
    savedAt: 1_700_000_000_000,
    ...over
});

describe('protocol constants', () => {
    it('pins the version, boot key, handshake bound and frame bound', () => {
        // These four are the deployment surface: a stale bundle gates on `version`, the
        // boot marker decides whether the entry self-starts, and the two bounds are the
        // numbers an operator tunes when a database grows.
        expect(IO_PROTOCOL_VERSION).toBe(1);
        expect(IO_WORKER_BOOT_KEY).toBe('harnessIoWorker');
        expect(IO_HANDSHAKE_MS).toBe(60_000);
        expect(IO_MAX_FRAME_BYTES).toBe(64 * 1024 * 1024);
    });

    it('names the durability outcome of every operation exactly', () => {
        // The R4 table: which answers mean "stable storage" and which only mean "the OS
        // has it". A reviewer checks this against the durability requirement, and a test
        // is the only place it can be checked without reading the writer.
        expect(IO_DURABLE_OUTCOMES).toEqual({
            'checkpoint.save': 'durable',
            'journal.open': 'written',
            'journal.append': 'written',
            'journal.flush': 'durable',
            'journal.rewrite': 'durable',
            'journal.truncate': 'durable',
            'journal.remove': 'durable',
            'journal.close': 'durable'
        });
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
        expect(isIoCommand({ kind: 'nonsense', callId: 1, target })).toBe(false);
        expect(isIoCommand({ kind: 'checkpoint.save', callId: 0, target })).toBe(false);
        expect(isIoCommand({ kind: 'checkpoint.save', callId: 1.5, target })).toBe(false);
        expect(isIoCommand({ kind: 'hello', callId: 1 })).toBe(false);
        expect(isIoCommand({ kind: 'shutdown', callId: 0 })).toBe(false);
        expect(isIoCommand(save({ target: undefined }))).toBe(false);
        expect(isIoCommand(save({ target: { directory: '', file: '/x/state.json' } }))).toBe(false);
        expect(isIoCommand(save({ savedAt: Number.NaN }))).toBe(false);
        expect(isIoCommand(save({ document: null }))).toBe(false);
        expect(isIoCommand(save({ document: 'not-an-object' }))).toBe(false);
        expect(isIoCommand(null)).toBe(false);
        expect(isIoCommand('checkpoint.save')).toBe(false);
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

describe('isIoReply', () => {
    it('accepts every legal answer the worker produces', () => {
        expect(isIoReply({ kind: 'hello', callId: 0, version: IO_PROTOCOL_VERSION, ok: true })).toBe(true);
        expect(isIoReply({ kind: 'bye', callId: 3, ok: true, drained: 2 })).toBe(true);
        expect(isIoReply({ kind: 'result', callId: 3, ok: true, outcome: 'durable', durationMs: 1.5, bytes: 12 })).toBe(true);
        expect(isIoReply({ kind: 'result', callId: 4, ok: true, outcome: 'written', durationMs: 0.25 })).toBe(true);
        expect(isIoReply({ kind: 'failure', callId: 5, ok: false, durationMs: 0.5, error: { message: 'ENOENT', code: 'ENOENT', path: '/x' } })).toBe(true);
        expect(isIoReply({ kind: 'fault', message: 'Unrecognized IO frame: undefined.' })).toBe(true);
        expect(isIoReply({ kind: 'fault', callId: 6, message: 'bad frame' })).toBe(true);
    });

    it('refuses the answers that would make durability ambiguous', () => {
        // 'superseded' is the COORDINATOR's word for a dropped queued checkpoint; if a
        // worker ever answered with it, the client's receipt type would lie.
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

describe('target and key helpers', () => {
    it('validates targets by the fields the writer indexes into', () => {
        expect(isIoCheckpointTarget(target)).toBe(true);
        expect(isIoCheckpointTarget({ directory: '/db/harness' })).toBe(false);
        expect(isIoCheckpointTarget({ directory: '/db/harness', file: '' })).toBe(false);
        expect(isIoJournalTarget(journal)).toBe(true);
        expect(isIoJournalTarget({ root: '/db/harness' })).toBe(false);
    });

    it('derives one stable key per journal handle, and a distinct one per session', () => {
        expect(ioJournalKey(journal)).toBe('/db/harness\u0000session-1');
        expect(ioJournalKey({ root: '/db/harness', sessionId: 'session-2' })).toBe('/db/harness\u0000session-2');
        expect(ioJournalKey({ root: '/other', sessionId: 'session-1' })).not.toBe(ioJournalKey(journal));
    });

    it('names an offending frame without echoing a whole document', () => {
        expect(describeIoFrame(save())).toBe('kind="checkpoint.save" callId=1');
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
        const raw = Object.assign(new Error("ENOENT: no such file or directory, rename 'a' -> 'b'"), { code: 'ENOENT', path: 'a' });
        const wrapper = new Error('/db/harness/state.json: Could not write the harness database: ENOENT: no such file or directory, rename \'a\' -> \'b\'');

        (wrapper as Error & { cause?: unknown }).cause = raw;
        (wrapper as Error & { file?: string }).file = '/db/harness/state.json';

        expect(ioErrorReportOf(wrapper)).toEqual({
            message: "/db/harness/state.json: Could not write the harness database: ENOENT: no such file or directory, rename 'a' -> 'b'",
            code: 'ENOENT',
            path: '/db/harness/state.json',
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
    it('accepts a real document and refuses a value that cannot cross a port', () => {
        // Not used per frame in the hot path (that would double the clone cost -
        // see ./io-client.ts `post`), but it is the pre-flight a caller can run once
        // before committing to a document shape.
        expect(isTransferableIoFrame(save())).toBe(true);
        expect(isTransferableIoFrame({ document: () => 1 })).toBe(false);
        expect(isTransferableIoFrame({ document: Symbol('s') })).toBe(false);
    });
});

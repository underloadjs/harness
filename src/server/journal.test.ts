// The per-step durable journal (R4).
//
// These tests pin the two durability rules the design depends on:
//   1. a crash-truncated TAIL is tolerated (the record was never complete), and
//   2. corruption anywhere ELSE is EXPLICIT — reported, never repaired silently.
// They also pin the file format (one JSON record per line, header first), the
// compaction/remove lifecycle that keeps a reset or a deletion from replaying stale
// events, and the rule that a write failure is surfaced instead of swallowed.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../harness';
import {
    HARNESS_JOURNAL_FILE,
    HARNESS_JOURNAL_VERSION,
    HarnessJournal,
    journalLine
} from './journal';
import type { JournalEventRecord } from './journal';

// Scratch belongs in the repo-root Temp/ (AGENTS.md), never the OS temp dir.
const PACKAGE_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const roots: string[] = [];

const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-journal-${label}-`));

    roots.push(root);

    return root;
};

afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const event = (delta: string): HarnessEvent => ({ type: 'text', agent: 'one', delta });

const record = (turnId: string, index: number, at: number, delta: string): JournalEventRecord => ({
    type: 'event',
    v: HARNESS_JOURNAL_VERSION,
    turnId,
    index,
    at,
    event: event(delta)
});

const open = (root: string, sessionId = 'session-1'): HarnessJournal => {
    const journal = new HarnessJournal(root, sessionId);

    journal.open();

    return journal;
};

const rawText = (journal: HarnessJournal): string => fs.readFileSync(journal.file, 'utf8');

describe('append and read', () => {
    it('writes a header line first, then one JSON record per event, in order', () => {
        const journal = open(tempRoot('order'));

        expect(journal.error).toBeUndefined();

        journal.append({ turnId: 't1', index: 0, at: 1_000, event: event('a') });
        journal.append({ turnId: 't1', index: 1, at: 1_001, event: event('b') });
        journal.flush();

        const read = journal.read();

        expect(read.missing).toBe(false);
        expect(read.empty).toBe(false);
        expect(read.problems).toEqual([]);
        expect(read.header).toMatchObject({ type: 'header', v: 1, sessionId: 'session-1' });
        expect(read.events.map((entry) => entry.event)).toEqual([event('a'), event('b')]);
        expect(read.events.map((entry) => [entry.turnId, entry.index, entry.at])).toEqual([
            ['t1', 0, 1_000],
            ['t1', 1, 1_001]
        ]);

        // The wire format is part of the contract: a hand-inspectable JSONL file.
        const lines = rawText(journal).split('\n').filter((line) => line.length > 0);

        expect(lines).toHaveLength(3);
        expect(lines[1]).toBe(journalLine({ type: 'event', v: 1, turnId: 't1', index: 0, at: 1_000, event: event('a') }).trimEnd());
        expect(journal.file).toBe(path.join(journal.directory, HARNESS_JOURNAL_FILE));
    });

    it('treats a session with no journal file as MISSING, not empty', () => {
        const journal = new HarnessJournal(tempRoot('missing'), 'never-ran');

        const read = journal.read();

        expect(read.missing).toBe(true);
        expect(read.events).toEqual([]);
        expect(read.problems).toEqual([]);
    });

    it('appends every event kind verbatim, including a text delta and a tool result', () => {
        const journal = open(tempRoot('kinds'));
        const toolResult: HarnessEvent = {
            type: 'tool_result',
            agent: 'one',
            name: 'read',
            callId: 'call-1',
            content: 'x'.repeat(70_000),
            isError: false,
            outcome: 'completed',
            durationMs: 12
        };

        journal.append({ turnId: 't1', index: 0, at: 1, event: event('delta') });
        journal.append({ turnId: 't1', index: 1, at: 2, event: toolResult });

        const read = journal.read();

        // A 70 KiB model-facing result (above the 64 KiB budget cap) survives intact:
        // the lazy detail route must be able to answer with these exact bytes.
        expect(read.events[1].event).toEqual(toolResult);
    });
});

describe('crash tolerance', () => {
    it('tolerates a truncated last line and keeps every complete record', () => {
        const journal = open(tempRoot('tail'));

        journal.append({ turnId: 't1', index: 0, at: 1, event: event('a') });
        journal.append({ turnId: 't1', index: 1, at: 2, event: event('b') });
        journal.flush();

        // Simulate the crash: half of a third record on disk, with no newline.
        fs.appendFileSync(journal.file, '{"type":"event","v":1,"turnId":"t1","ind');

        const read = journal.read();

        expect(read.events.map((entry) => entry.index)).toEqual([0, 1]);
        expect(read.truncatedTail ?? true).toBe(true);
        expect(read.problems).toHaveLength(1);
        expect(read.problems[0]).toMatchObject({ line: 4, tail: true });
    });

    it('reports corruption in the MIDDLE of the file as a non-tail problem', () => {
        const journal = open(tempRoot('midfile'));
        const header = rawText(journal);
        const a = journalLine({ type: 'event', v: HARNESS_JOURNAL_VERSION, turnId: 't1', index: 0, at: 1, event: event('a') });
        const b = journalLine({ type: 'event', v: HARNESS_JOURNAL_VERSION, turnId: 't1', index: 1, at: 2, event: event('b') });

        // Garbage BETWEEN two complete records: a lost line, not a crash tail.
        // (`journalLine` already terminates each record, so no extra \n after `b`.)
        fs.writeFileSync(journal.file, `${header}${a}\n${b}`, 'utf8');

        const read = journal.read();

        // The good records still parse (a reader may keep them), but the stream is
        // flagged: nothing may treat this log as healthy.
        expect(read.events.map((entry) => entry.index)).toEqual([0, 1]);
        expect(read.truncatedTail).toBe(false);
        expect(read.problems).toHaveLength(1);
        expect(read.problems[0]).toMatchObject({ line: 3, kind: 'malformed', reason: 'empty line', tail: false });
    });

    it('reports a per-turn index gap instead of silently closing it', () => {
        const journal = open(tempRoot('gap'));

        journal.append({ turnId: 't1', index: 0, at: 1, event: event('a') });
        journal.append({ turnId: 't1', index: 2, at: 3, event: event('c') });
        journal.flush();

        const read = journal.read();

        expect(read.events).toHaveLength(2);
        expect(read.problems).toEqual([
            {
                line: 3,
                kind: 'sequence',
                reason: 'turn t1 expected event index 1, found 2',
                tail: false
            }
        ]);
    });

    it('rejects a record of a version this server does not write', () => {
        const journal = open(tempRoot('version'));

        fs.appendFileSync(
            journal.file,
            `${JSON.stringify({ type: 'event', v: 99, turnId: 't1', index: 0, at: 1, event: event('a') })}\n`,
            'utf8'
        );

        const read = journal.read();

        // A COMPLETE line of an unknown version is corruption, not a crash tail: the
        // reader refuses rather than guessing a format it did not write.
        expect(read.events).toEqual([]);
        expect(read.truncatedTail).toBe(false);
        expect(read.problems).toEqual([
            {
                line: 2,
                kind: 'malformed',
                reason: 'unsupported journal version 99; this server writes version 1',
                tail: false
            }
        ]);
    });
});

describe('lifecycle', () => {
    it('rewrite replaces the log, truncate clears it, remove deletes the directory', () => {
        const root = tempRoot('lifecycle');
        const journal = open(root);

        journal.append({ turnId: 't1', index: 0, at: 1, event: event('a') });
        journal.append({ turnId: 't2', index: 0, at: 2, event: event('b') });
        journal.flush();

        // Compaction after a thread deletion: only the surviving turn's events stay.
        journal.rewrite([record('t2', 0, 2, 'b')]);

        expect(journal.read().events.map((entry) => entry.turnId)).toEqual(['t2']);

        journal.truncate();

        const cleared = journal.read();

        expect(cleared.empty).toBe(true);
        expect(cleared.missing).toBe(false);
        expect(cleared.events).toEqual([]);

        journal.remove();

        expect(fs.existsSync(journal.directory)).toBe(false);
        expect(journal.read().missing).toBe(true);
    });

    it('surfaces a write failure on the journal instead of throwing or hiding it', () => {
        const root = tempRoot('write-error');

        // A regular file where the journal DIRECTORY must be: mkdir fails (ENOTDIR),
        // deterministically on every platform, without needing permissions.
        fs.writeFileSync(path.join(root, 'sessions'), 'occupied', 'utf8');

        const journal = new HarnessJournal(root, 'blocked');

        journal.open();

        expect(journal.error).toBeTypeOf('string');
        expect(journal.failures).toBeGreaterThan(0);
        expect(journal.append({ turnId: 't1', index: 0, at: 1, event: event('a') })).toBe(false);

        // Reading a session whose log could never be written says "missing", and the
        // recorded failure is still there to report.
        expect(journal.read().missing).toBe(true);
        expect(journal.error).toBeTypeOf('string');
    });
});

// The IO worker's operation table, driven in-process against the real filesystem.
//
// `executeIoCommand` is the whole worker body minus the message port, so these tests
// exercise THE SAME dispatch ./io-client.test.ts runs on a real worker thread - one
// operation in, one receipt out, real files on disk under the repo-root Temp/.
//
// What they pin:
//   - byte-identity with the inline writer (the two write modes must not produce two
//     different databases),
//   - failure-text parity, so a 500 or a journal report reads the same in both modes,
//   - the exact durability answer for every operation ('durable' vs 'written'),
//   - and the refusals that must be loud: an unknown frame, an oversized document.
//
// Note on state: the worker caches one `HarnessJournal` per (root, sessionId) in a
// module map, so each test uses its own session id, and the `shutdown` test runs last
// (vitest executes declarations in order) because draining affects every cached handle.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HarnessJournal, journalLine, HARNESS_JOURNAL_VERSION } from '../journal';
import { HarnessPersistence, serializeHarnessDatabase, writeHarnessDatabaseFile, createHarnessStagingSequence } from '../persistence';
import type { HarnessDatabase } from '../persistence';
import {
    configureIoWorker,
    executeIoCommand,
    ioWorkerLimits,
    ioWorkerOpenJournals,
    runIoWorker
} from './io-worker-loop';
import { IO_PROTOCOL_VERSION, ioJournalKey } from './io-protocol';
import type { IoCheckpointTarget, IoJournalTarget, IoReply, IoResult } from './io-protocol';

// This file is one directory deeper than ../journal.test.ts (src/server/workers), so
// the package root is three levels up. Scratch still belongs in the REPO-root Temp/.
const PACKAGE_ROOT = path.resolve(__dirname, '../../..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const roots: string[] = [];

const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-io-worker-${label}-`));

    roots.push(root);

    return root;
};

afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// The checkpoint target of one root, spelled the way `HarnessPersistence` spells it, so
// a mismatch between the two spellings would fail these tests instead of quietly
// writing somewhere else.
const checkpointTarget = (root: string): IoCheckpointTarget => {
    const directory = path.join(root, 'harness');

    return { directory, file: path.join(directory, 'state.json') };
};

const journalTarget = (root: string, sessionId: string): IoJournalTarget => ({
    root: path.join(root, 'harness'),
    sessionId
});

// A record the store's own reader accepts: `definition` and `preset` carry every field
// `readDescriptor`/`readPresetRecord` require, and `usage.total` is mandatory, so a
// worker-written document survives `load()` for the same reasons a real one does.
const PRESET = {
    name: 'live',
    title: 'Live',
    description: 'd',
    requiresEndpoint: false,
    primary: 'a',
    subagents: [],
    agents: ['a'],
    tools: [],
    builtin: true,
    editable: true,
    template: 'scripted' as const
};

const DEFINITION = {
    name: 'live',
    title: 'Live',
    description: 'd',
    requiresEndpoint: false,
    primary: 'a',
    subagents: [],
    agents: ['a'],
    tools: [],
    builtin: true,
    editable: true
};

const document = (marker: string): HarnessDatabase => ({
    version: 1,
    savedAt: 1,
    registry: [],
    sessions: [
        {
            id: 'session-1',
            harness: 'live',
            preset: { ...PRESET },
            definition: { ...DEFINITION },
            settings: { baseURL: 'http://scripted.invalid/v1', model: 'scripted/test' },
            status: 'idle',
            createdAt: 1_000,
            updatedAt: 2_000,
            turns: [
                {
                    index: 0,
                    id: `turn-${marker}`,
                    prompt: marker,
                    status: 'done',
                    startedAt: 1,
                    updatedAt: 2,
                    usage: { input: 1, output: 1, total: 2 },
                    events: []
                }
            ],
            queue: [],
            core: { version: 1, agents: {}, memory: {} } as unknown as HarnessDatabase['sessions'][number]['core']
        }
    ]
});

// A frame in, the worker's reply out. Typed loosely on purpose: part of what these
// tests pin is that a MALFORMED frame is refused, so the helper cannot demand a shape.
const call = (frame: unknown): IoReply => executeIoCommand(frame);

const unwrap = (reply: IoReply): IoResult => {
    expect(reply.kind).toBe('result');

    return reply as IoResult;
};

describe('handshake and shutdown', () => {
    it('answers hello with the protocol version this build speaks', () => {
        expect(call({ kind: 'hello', callId: 0 })).toEqual({ kind: 'hello', callId: 0, version: IO_PROTOCOL_VERSION, ok: true });
    });

    it('refuses a frame it cannot parse, naming the offender', () => {
        // A silently dropped frame shows up later as a request that never returned, so
        // the answer must say which frame and why.
        expect(call({ kind: 'checkpoint.save', callId: 0 })).toEqual({ kind: 'fault', message: 'Unrecognized IO frame: kind="checkpoint.save" callId=0.' });
        expect(call(null)).toEqual({ kind: 'fault', message: 'Unrecognized IO frame: object.' });
        expect(call({ kind: 'journal.append', callId: 3, target: { root: '/r', sessionId: 's' }, record: { turnId: 't', index: -1, at: 1, event: {} } })).toEqual({
            kind: 'fault',
            // A rejected frame still names its operation, so the caller waiting on that
            // callId is told instead of left hanging.
            callId: 3,
            message: 'Unrecognized IO frame: kind="journal.append" callId=3.'
        });
    });
});

describe('checkpoint.save', () => {
    it('commits the document durably and reports the exact bytes it wrote', () => {
        const root = tempRoot('save');
        const target = checkpointTarget(root);
        const savedAt = 1_700_000_000_000;

        const reply = unwrap(call({ kind: 'checkpoint.save', callId: 1, target, document: document('one'), savedAt }));

        expect(reply.outcome).toBe('durable');
        expect(reply.bytes).toBe(serializeHarnessDatabase(document('one'), savedAt).length);
        expect(reply.durationMs).toBeTypeOf('number');

        // The restart path is the real test: the store reads what the worker wrote with
        // its own loader, no worker involved.
        const loaded = new HarnessPersistence(root).load();

        expect(loaded?.savedAt).toBe(savedAt);
        expect(loaded?.sessions[0]?.turns[0]?.id).toBe('turn-one');

        // No staging file survives a successful commit.
        expect(fs.readdirSync(target.directory)).toEqual(['state.json']);
    });

    it('writes byte-identical bytes to the synchronous inline writer', () => {
        // The one property that makes two write modes safe: the same document through
        // either path is the same file, so a database written in worker mode restores in
        // inline mode and back.
        const workerRoot = tempRoot('identity-worker');
        const inlineRoot = tempRoot('identity-inline');
        const savedAt = 1_700_000_000_001;
        const doc = document('same');

        unwrap(call({ kind: 'checkpoint.save', callId: 2, target: checkpointTarget(workerRoot), document: doc, savedAt }));

        const inlineFile = path.join(inlineRoot, 'harness', 'state.json');

        writeHarnessDatabaseFile(path.join(inlineRoot, 'harness'), inlineFile, serializeHarnessDatabase(doc, savedAt), { sequence: createHarnessStagingSequence() });

        expect(fs.readFileSync(checkpointTarget(workerRoot).file, 'utf8')).toBe(fs.readFileSync(inlineFile, 'utf8'));
        expect(fs.readFileSync(checkpointTarget(workerRoot).file, 'utf8')).toBe(serializeHarnessDatabase(doc, savedAt));
    });

    it('refuses to commit a document above the configured frame bound', () => {
        const root = tempRoot('oversize');
        const target = checkpointTarget(root);
        const previous = ioWorkerLimits();

        configureIoWorker({ maxFrameBytes: 64 });

        const reply = call({ kind: 'checkpoint.save', callId: 3, target, document: document('wide'), savedAt: 1 });

        configureIoWorker(previous);

        expect(reply).toEqual({
            kind: 'failure',
            callId: 3,
            ok: false,
            durationMs: expect.any(Number),
            // The refusal still reports the measured size: that is how the coordinator
            // learns to stop cloning a database it cannot commit (./io-client.ts).
            bytes: serializeHarnessDatabase(document('wide'), 1).length,
            error: {
                code: 'frame-too-large',
                message: `The harness database is ${serializeHarnessDatabase(document('wide'), 1).length} bytes, above the 64 byte IO frame limit.`,
                path: target.file
            }
        });

        // Refused means NOT written: the database is exactly as it was (absent).
        expect(new HarnessPersistence(root).load()).toBeUndefined();
        expect(ioWorkerLimits()).toEqual(previous);
    });

    it('reports a failed commit with the message the inline save() throws', () => {
        // `<root>/occupied` is a regular file, so the database directory cannot be
        // created. The exact errno text differs by platform, so the assertion is equality
        // BETWEEN the two modes, which is the property that matters for the 500 body.
        const workerRoot = tempRoot('blocked-worker');
        const inlineRoot = tempRoot('blocked-inline');

        fs.writeFileSync(path.join(workerRoot, 'occupied'), 'x', 'utf8');
        fs.writeFileSync(path.join(inlineRoot, 'occupied'), 'x', 'utf8');

        const workerTarget: IoCheckpointTarget = {
            directory: path.join(workerRoot, 'occupied', 'harness'),
            file: path.join(workerRoot, 'occupied', 'harness', 'state.json')
        };

        const reply = call({ kind: 'checkpoint.save', callId: 4, target: workerTarget, document: document('blocked'), savedAt: 1 });

        expect(reply.kind).toBe('failure');

        let inlineMessage = '';
        const inlinePersistence = new HarnessPersistence(path.join(inlineRoot, 'occupied'));

        try {
            // Rooted at the occupied NAME, so the directory this writer wants to create
            // is `<occupied>/harness` - i.e. the same blocker the worker target hits.
            inlinePersistence.save(document('blocked'));
        } catch (error) {
            inlineMessage = error instanceof Error ? error.message : String(error);
        }

        // Same file spelling per mode, so the message texts must match byte for byte
        // once the root names are normalized. `split/join` replaces EVERY occurrence:
        // the mkdir path inside the cause mentions the same root a second time.
        const normalize = (value: string, root: string): string => value.split(root).join('<root>');
        const report = (reply as Extract<IoReply, { kind: 'failure' }>).error;
        const workerMessage = report.message;

        // The report carries BOTH texts on purpose: `message` is what a thrown error
        // says (a 500 body), `cause` is what `persistence.lastWriteError` says (the raw
        // failure), and the two differ by exactly the wrapper (../persistence.ts `causeOf`).
        expect(report.cause).toBe((inlinePersistence.lastWriteError as string).split(inlineRoot).join(workerRoot));

        // The comparison is only meaningful if the inline writer really failed too.
        expect(inlineMessage).not.toBe('');
        expect(normalize(workerMessage, workerRoot)).toBe(normalize(inlineMessage, inlineRoot));
        // The prefix is the actionable half: the file, and which stage of the commit
        // failed. The errno text after it is platform wording, already compared above.
        expect(workerMessage.startsWith(`${workerTarget.file}: Could not create the harness database directory: `)).toBe(true);
        expect(fs.existsSync(workerTarget.file)).toBe(false);
    });
});

describe('journal operations', () => {
    it('opens once, writes the header, and appends every event in call order', () => {
        const root = tempRoot('journal-order');
        const target = journalTarget(root, 'sess-order');

        unwrap(call({ kind: 'journal.open', callId: 10, target }));

        const lines = ['a', 'b', 'c'];

        lines.forEach((delta, index) => {
            const reply = call({ kind: 'journal.append', callId: 11 + index, target, record: { turnId: 't1', index, at: 1_000 + index, event: { type: 'text', agent: 'one', delta } } });

            // 'written', not 'durable': the line is in the file through a held handle,
            // and only a flush fences it (./io-protocol.ts).
            expect(unwrap(reply).outcome).toBe('written');
        });

        expect(unwrap(call({ kind: 'journal.flush', callId: 20, target })).outcome).toBe('durable');

        const read = new HarnessJournal(path.join(root, 'harness'), 'sess-order').read();

        expect(read.missing).toBe(false);
        expect(read.problems).toEqual([]);
        expect(read.truncatedTail).toBe(false);
        expect(read.events.map((entry) => [entry.turnId, entry.index, entry.at, (entry.event as { delta?: string }).delta])).toEqual([
            ['t1', 0, 1_000, 'a'],
            ['t1', 1, 1_001, 'b'],
            ['t1', 2, 1_002, 'c']
        ]);

        // The wire format is the store's own, line for line.
        const text = fs.readFileSync(path.join(target.root, 'sessions', 'sess-order', 'events.jsonl'), 'utf8');
        const header = text.split('\n')[0];

        expect(JSON.parse(header)).toEqual({ type: 'header', v: HARNESS_JOURNAL_VERSION, sessionId: 'sess-order', createdAt: expect.any(Number) });
        expect(text.split('\n')[1]).toBe(journalLine({ type: 'event', v: HARNESS_JOURNAL_VERSION, turnId: 't1', index: 0, at: 1_000, event: { type: 'text', agent: 'one', delta: 'a' } }).trimEnd());
    });

    it('keeps one append handle per session so ordering is the file order', () => {
        // Two sessions in one worker: each handle is separate, and the interleaved
        // calls still produce two per-session logs in call order.
        const root = tempRoot('journal-two-sessions');
        const first = journalTarget(root, 'sess-a');
        const second = journalTarget(root, 'sess-b');

        call({ kind: 'journal.append', callId: 30, target: first, record: { turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: 'a1' } } });
        call({ kind: 'journal.append', callId: 31, target: second, record: { turnId: 't2', index: 0, at: 2, event: { type: 'text', agent: 'a', delta: 'b1' } } });
        call({ kind: 'journal.append', callId: 32, target: first, record: { turnId: 't1', index: 1, at: 3, event: { type: 'text', agent: 'a', delta: 'a2' } } });

        expect(ioJournalKey(first)).toBe(`${first.root}\u0000sess-a`);

        expect(new HarnessJournal(first.root, 'sess-a').read().events.map((entry) => (entry.event as { delta?: string }).delta)).toEqual(['a1', 'a2']);
        expect(new HarnessJournal(second.root, 'sess-b').read().events.map((entry) => (entry.event as { delta?: string }).delta)).toEqual(['b1']);
    });

    it('compacts with rewrite, clears with truncate, and both are durable', () => {
        const root = tempRoot('journal-rewrite');
        const target = journalTarget(root, 'sess-rewrite');

        for (let index = 0; index < 3; index += 1) {
            call({ kind: 'journal.append', callId: 40 + index, target, record: { turnId: 't1', index, at: index, event: { type: 'text', agent: 'a', delta: `d${index}` } } });
        }

        expect(unwrap(call({ kind: 'journal.rewrite', callId: 44, target, records: [{ turnId: 't1', index: 0, at: 0, event: { type: 'text', agent: 'a', delta: 'd0' } }] })).outcome).toBe('durable');

        const compacted = new HarnessJournal(target.root, 'sess-rewrite').read();

        expect(compacted.events).toHaveLength(1);
        expect(compacted.events[0]).toEqual({
            type: 'event',
            v: HARNESS_JOURNAL_VERSION,
            turnId: 't1',
            index: 0,
            at: 0,
            event: { type: 'text', agent: 'a', delta: 'd0' }
        });

        expect(unwrap(call({ kind: 'journal.truncate', callId: 45, target })).outcome).toBe('durable');

        const cleared = new HarnessJournal(target.root, 'sess-rewrite').read();

        expect(cleared.empty).toBe(true);
        expect(cleared.missing).toBe(false);
        expect(cleared.problems).toEqual([]);
    });

    it('removes the log for a deleted session and reports it durable', () => {
        const root = tempRoot('journal-remove');
        const target = journalTarget(root, 'sess-remove');

        call({ kind: 'journal.append', callId: 50, target, record: { turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: 'x' } } });

        expect(unwrap(call({ kind: 'journal.remove', callId: 51, target })).outcome).toBe('durable');
        expect(fs.existsSync(path.join(target.root, 'sessions', 'sess-remove'))).toBe(false);

        // A later frame for the same session re-attaches (a recreated session), exactly
        // as the store's `attachJournal` does.
        call({ kind: 'journal.append', callId: 52, target, record: { turnId: 't2', index: 0, at: 2, event: { type: 'text', agent: 'a', delta: 'y' } } });

        const read = new HarnessJournal(target.root, 'sess-remove').read();

        expect(read.events.map((entry) => entry.turnId)).toEqual(['t2']);
    });

    it('reports a journal failure with the same text the inline handle reports', () => {
        // Two roots, one blocker each, ONE session id: the failure text embeds the mkdir
        // path, so the only way to compare the two modes exactly is to normalize the root
        // name. That comparison is the point - the store prefixes this string into its
        // report, and the report must not differ between modes.
        const root = tempRoot('journal-blocked');
        const inlineRoot = tempRoot('journal-blocked-inline');

        for (const blocked of [root, inlineRoot]) {
            // A regular file where the journal DIRECTORY must go: mkdir fails
            // deterministically on every platform (../journal.test.ts:244 uses the same
            // blocker), without needing permissions.
            fs.writeFileSync(path.join(blocked, 'harness'), 'occupied', 'utf8');
        }

        const target = journalTarget(root, 'sess-blocked');
        const reply = call({ kind: 'journal.append', callId: 60, target, record: { turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: 'x' } } });

        expect(reply.kind).toBe('failure');

        const failure = reply as Extract<IoReply, { kind: 'failure' }>;

        expect(failure.error.code).toBe('journal');
        expect(failure.error.path).toBe(path.join(target.root, 'sessions', 'sess-blocked', 'events.jsonl'));

        // The store reads `journal.error` inline and `journalError(id)` in worker mode;
        // the strings must be identical or its reporter drifts between modes.
        const inline = new HarnessJournal(path.join(inlineRoot, 'harness'), 'sess-blocked');

        inline.append({ turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: 'x' } });

        expect(inline.error).toBeTypeOf('string');
        expect(failure.error.message).toBe((inline.error as string).replace(inlineRoot, root));
        expect(failure.error.message).toContain('sess-blocked');
    });

    it('closes a handle without deleting the log, and drains every handle on shutdown', () => {
        // Declared last: `shutdown` fences and drops EVERY cached handle, so a later
        // test in this file could not rely on one still being open. The worker's handle
        // map is module state shared by this file's tests, so the drain count is
        // asserted relative to what this test found open - exact, and independent of the
        // unrelated tests that ran before it.
        const root = tempRoot('journal-close');
        const target = journalTarget(root, 'sess-close');
        const openBefore = ioWorkerOpenJournals();

        call({ kind: 'journal.append', callId: 70, target, record: { turnId: 't1', index: 0, at: 1, event: { type: 'text', agent: 'a', delta: 'kept' } } });

        expect(ioWorkerOpenJournals()).toBe(openBefore + 1);

        expect(unwrap(call({ kind: 'journal.close', callId: 71, target })).outcome).toBe('durable');

        // A close releases the handle but keeps the log, and the cached instance with it.
        expect(ioWorkerOpenJournals()).toBe(openBefore);

        const afterClose = new HarnessJournal(target.root, 'sess-close').read();

        expect(afterClose.events.map((entry) => (entry.event as { delta?: string }).delta)).toEqual(['kept']);

        call({ kind: 'journal.append', callId: 72, target, record: { turnId: 't1', index: 1, at: 2, event: { type: 'text', agent: 'a', delta: 'tail' } } });

        expect(call({ kind: 'shutdown', callId: 73, reason: 'test' })).toEqual({ kind: 'bye', callId: 73, ok: true, drained: openBefore + 1 });
        expect(ioWorkerOpenJournals()).toBe(0);

        // The tail written without an explicit flush survived the shutdown drain, which
        // is the whole point of fencing handles on the way out.
        expect(new HarnessJournal(target.root, 'sess-close').read().events.map((entry) => (entry.event as { delta?: string }).delta)).toEqual(['kept', 'tail']);
    });
});

describe('the message loop', () => {
    it('answers every frame it is given and releases the port after a shutdown', () => {
        const root = tempRoot('loop');
        const received: IoReply[] = [];
        const closed: string[] = [];
        const port = {
            on: (_event: 'message', listener: (data: unknown) => void) => {
                (port as unknown as { listener: (data: unknown) => void }).listener = listener;

                return port;
            },
            postMessage: (reply: IoReply) => received.push(reply),
            close: () => closed.push('closed'),
            listener: undefined as unknown as (data: unknown) => void
        };

        runIoWorker(port as never);

        port.listener({ kind: 'hello', callId: 0 });
        port.listener({ kind: 'journal.open', callId: 1, target: journalTarget(root, 'sess-loop') });
        port.listener({ kind: 'shutdown', callId: 2 });

        expect(received.map((reply) => reply.kind)).toEqual(['hello', 'result', 'bye']);
        expect((received[1] as IoResult).outcome).toBe('written');
        expect((received[2] as Extract<IoReply, { kind: 'bye' }>).drained).toBe(1);
        // A shutdown releases the port so the thread can exit without a terminate call.
        expect(closed).toEqual(['closed']);
    });
});

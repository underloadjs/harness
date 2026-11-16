// SHARED TEST READER FOR THE v2 ON-DISK HARNESS LAYOUT.
//
// WHY THIS MODULE EXISTS
// ----------------------
// The harness database moved from ONE whole-document file (`<root>/harness/state.json`,
// version 1) to a sharded directory layout (version 2):
//
//   <root>/harness/index.json                      { version, savedAt, registry, deleted?,
//                                                    globalSettings?, pluginSettings?,
//                                                    toolSettings?, sessions: [{ id, ordinal }] }
//   <root>/harness/sessions/<id>/session.json      the session record; `core.threads[]` rows
//                                                    carry NO `messages`
//   <root>/harness/sessions/<id>/threads/<tid>.json { version, sessionId, id, messages }
//   <root>/harness/sessions/<id>/events.jsonl      unchanged (./journal.ts)
//   <root>/harness/agents.json                     unchanged (./persistence.ts T19 overlay)
//
// The move changed ONLY WHERE bytes live: `HarnessPersistence.load()`/`save()` and the
// in-memory `HarnessDatabase` are untouched, so every test that goes through `load()` still
// needs nothing. What DID change is every test that reaches for the file directly — it used
// to parse one document and index `document.sessions[0]`. Those sites now need a shard path.
//
// Rather than repeat `readFileSync(path.join(root,'harness',...))` per site (30+ files), all
// of them call the readers below, so a later layout tweak is a one-file change again. The
// readers deliberately return UNTYPED records (`Record<string, any>`): the tests that use them
// tamper with raw JSON on purpose (durability/repair pins), and narrowing the type would hide
// exactly the shape those pins are about.
//
// SEMANTIC RULE: a reader is a PATH translator, not an assertion. It never relaxes what a
// test checks — `readPersistedSessions(root)[0]` stands in for the old
// `readDocument(root).sessions[0]`, in the same index order the old document guaranteed
// (`index.json` `sessions[].ordinal` is that order).

import fs from 'node:fs';
import path from 'node:path';

// v2 file names. Spelled out here (not imported from ./persistence) on purpose, and so is the
// `path.resolve` below: these readers must stay independent of the writer, so a writer that
// changes its layout constants without telling the tests fails loudly instead of moving with
// them. It also keeps this module free of any production import, which the suites that spawn
// a child process (./dev.test.ts, ./service-start.test.ts) depend on.
export const HARNESS_INDEX_FILE = 'index.json';
export const HARNESS_SESSION_FILE = 'session.json';
export const HARNESS_THREAD_DIRECTORY = 'threads';
export const HARNESS_SESSIONS_DIRECTORY = 'sessions';

// `<root>/harness` — resolved the same way the store resolves it (./persistence.ts
// `resolveHarnessDatabaseRoot`), so a relative test root and an absolute one agree.
export const harnessDirectoryOf = (root: string): string =>
    path.join(path.resolve(root), 'harness');

// The v2 document header (`index.json`), the per-session record, and the per-thread
// transcript shard. `harnessSessionFileOf` mirrors `HarnessPersistence.sessionFile(sessionId)`.
export const harnessIndexFileOf = (root: string): string =>
    path.join(harnessDirectoryOf(root), HARNESS_INDEX_FILE);

export const harnessSessionFileOf = (root: string, sessionId: string): string =>
    path.join(harnessDirectoryOf(root), HARNESS_SESSIONS_DIRECTORY, sessionId, HARNESS_SESSION_FILE);

export const harnessThreadFileOf = (root: string, sessionId: string, threadId: string): string =>
    path.join(
        harnessDirectoryOf(root),
        HARNESS_SESSIONS_DIRECTORY,
        sessionId,
        HARNESS_THREAD_DIRECTORY,
        `${threadId}.json`
    );

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8')) as any;

const writeJson = (file: string, value: unknown): void => {
    // Parent directories are created so a hand-written shard does not depend on the
    // store having opened this session (the repair pins write files the store never made).
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // COMPACT, exactly like `serializeHarnessShard` (./persistence.ts:2404-2421): the store's
    // incremental gate skips a shard whose bytes match the sha256 it last committed, so a
    // pretty-printed hand-write would re-dirty every shard the test did NOT tamper with and
    // turn a "this write touched only the index" pin into a false failure.
    fs.writeFileSync(file, JSON.stringify(value), 'utf8');
};

// The `index.json` document: `version`, `savedAt`, `registry`, the optional operator blocks
// (`deleted`/`globalSettings`/`pluginSettings`/`toolSettings`) and `sessions: [{id, ordinal}]`.
export const readPersistedIndex = (root: string): Record<string, any> => readJson(harnessIndexFileOf(root));

// The `sessions` entries of `index.json`, in the persisted order.
export const readPersistedIndexSessions = (root: string): { id: string; ordinal: number }[] =>
    readPersistedIndex(root).sessions;

// One session's persisted record (everything except the transcripts that live in
// `threads/<tid>.json`). Throws on ENOENT like the old `readDocument` did when a session
// that should exist is missing — that throw IS the failure a test wants.
export const readPersistedSession = (root: string, sessionId: string): Record<string, any> =>
    readJson(harnessSessionFileOf(root, sessionId));

// Same record, `undefined` when the session was never written (the old tests used
// `fs.existsSync(stateFile)` to distinguish "no document at all").
export const readPersistedSessionOrNull = (root: string, sessionId: string): Record<string, any> | undefined => {
    const file = harnessSessionFileOf(root, sessionId);

    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>) : undefined;
};

// Every session record, in `index.json` order — the direct replacement for the old
// `readDocument(root).sessions`.
export const readPersistedSessions = (root: string): Record<string, any>[] =>
    readPersistedIndexSessions(root).map((entry) => readPersistedSession(root, entry.id));

// One thread's transcript shard: `{ version, sessionId, id, messages }`.
export const readPersistedThread = (
    root: string,
    sessionId: string,
    threadId: string
): Record<string, any> => readJson(harnessThreadFileOf(root, sessionId, threadId));

// The `messages` array of one thread (the value the v1 document kept inline in
// `core.threads[i].messages`).
export const readPersistedThreadMessages = (root: string, sessionId: string, threadId: string): any[] =>
    readPersistedThread(root, sessionId, threadId).messages;

// Every transcript shard of a session as `threadId -> messages`. `index.json` does not list
// threads (the session record's `core.threads[]` rows do, minus their messages), so this
// reads the shard DIRECTORY — which is also what a "thread rows and shard files agree" pin
// wants: a row with no shard file is missing from this map.
export const readPersistedThreads = (root: string, sessionId: string): Record<string, any[]> => {
    const directory = path.join(
        harnessDirectoryOf(root),
        HARNESS_SESSIONS_DIRECTORY,
        sessionId,
        HARNESS_THREAD_DIRECTORY
    );

    if (!fs.existsSync(directory)) return {};

    const threads: Record<string, any[]> = {};

    for (const entry of fs.readdirSync(directory).sort()) {
        if (!entry.endsWith('.json')) continue;

        const thread = readJson(path.join(directory, entry));
        threads[thread.id] = thread.messages;
    }

    return threads;
};

// ---------------------------------------------------------------------------
// Writers (for the pins that hand-write or hand-corrupt a shard)
// ---------------------------------------------------------------------------

export const writePersistedIndex = (root: string, document: unknown): void =>
    writeJson(harnessIndexFileOf(root), document);

export const writePersistedSession = (root: string, record: unknown): void => {
    // The record carries its own id, so callers cannot desync the path from the payload.
    const id = (record as { id?: string })?.id;

    if (typeof id !== 'string' || id.length === 0) {
        throw new Error('writePersistedSession needs a record with an `id`.');
    }

    writeJson(harnessSessionFileOf(root, id), record);
};

export const writePersistedThread = (
    root: string,
    sessionId: string,
    threadId: string,
    document: unknown
): void => writeJson(harnessThreadFileOf(root, sessionId, threadId), document);

// Reads the whole v2 layout back into the ONE-document shape the v1 pins were written
// against: `{ ...index, sessions: [records with their `core.threads[].messages` put back] }`.
//
// WHY: several suites tamper with "the persisted document" as a single object and then write
// it back (a corrupt transcript, a foreign lease owner, a re-keyed turn). Rewriting that as
// three files at every call site invites drift; this keeps the test's mental model and lets
// `writePersistedDocument` fan the edits back out to the right shard.
export const readPersistedDocument = (root: string): Record<string, any> => {
    const index = readPersistedIndex(root);
    const sessions = readPersistedSessions(root).map((record) => {
        const next = { ...record } as Record<string, any>;

        if (next.core && Array.isArray(next.core.threads)) {
            next.core = {
                ...next.core,
                threads: next.core.threads.map((row: Record<string, any>) => {
                    const file = harnessThreadFileOf(root, record.id, row.id);

                    // A row whose shard is absent stays without `messages`: that is the
                    // store's own "unreadable/missing transcript" state, not a helper bug.
                    if (!fs.existsSync(file)) return { ...row };

                    return { ...row, messages: readJson(file).messages };
                })
            };
        }

        return next;
    });

    return { ...index, sessions };
};

// Fan a whole-document view (as produced by `readPersistedDocument`, usually after tampering)
// back out to its shards. Only the shard whose content actually changed is rewritten, so a
// durability pin that compares bytes of an untouched shard still sees the original bytes.
export const writePersistedDocument = (root: string, document: Record<string, any>): void => {
    const { sessions, ...index } = document as Record<string, any> & { sessions: Record<string, any>[] };

    // `index.json` lists sessions as `{ id, ordinal }` references, in that order — the reader
    // above turned those references into full records, so the writer turns them back. `ordinal`
    // is 1-based, matching `harnessIndexDocumentOf` (./persistence.ts:2329); it is informational
    // (read order is the array order), but a hand-written header that disagrees with the writer
    // would be a second source of truth.
    writePersistedIndex(root, {
        ...index,
        sessions: (sessions ?? []).map((record, position) => ({ id: record.id, ordinal: position + 1 }))
    });

    for (const record of sessions ?? []) {
        const core = record.core as Record<string, any> | undefined;

        // Shards that exist on disk but are no longer listed by this record's `core.threads[]`
        // rows are REMOVED. In v1 they could not survive: the single document was replaced
        // wholesale, so a thread dropped from `core.threads` lost its transcript with it. Keeping
        // the orphan would be a new behaviour, not a translation of the old one.
        const listed = new Set<string>(
            core && Array.isArray(core.threads) ? core.threads.map((row: Record<string, any>) => String(row.id)) : []
        );

        if (core && Array.isArray(core.threads)) {
            for (const stale of listPersistedThreadFiles(root, record.id)) {
                const threadId = stale.replace(/\.json$/, '');
                if (!listed.has(threadId)) {
                    fs.rmSync(harnessThreadFileOf(root, record.id, threadId), { force: true });
                }
            }
        }

        if (!core || !Array.isArray(core.threads)) {
            writePersistedSession(root, record);
            continue;
        }

        const threads: { id: string; messages: unknown; hasTranscript: boolean }[] = [];
        const rows = core.threads.map((row: Record<string, any>) => {
            const { messages, ...rowRest } = row;

            // `'messages' in row` (not `messages !== undefined`) is the question: a row
            // WITHOUT the key is the store's own torn/unreadable-transcript state, which in v1
            // meant "the document simply had no transcript for this row". Writing an envelope
            // anyway would create a file whose `messages` key `JSON.stringify` drops, and
            // ./persistence.ts `harnessThreadTranscriptOf` reads exactly that shape as
            // "unparseable shard" and hands back the raw TEXT instead of a missing transcript.
            threads.push({ id: String(row.id), messages, hasTranscript: 'messages' in row });

            return rowRest;
        });

        // The record shard holds the record itself (no envelope, no version —
        // ./persistence.ts:2407-2410), with the transcripts lifted off the thread rows.
        // Assigning `core` on a COPY of the record rather than spreading `{ ...rest, core }`
        // keeps `core` in its ORIGINAL key position, so the bytes match what the store itself
        // would serialize for an untouched record (`{ ...record, core: {...} }`) and its digest
        // still matches on the next save.
        const recordShard = { ...record } as Record<string, any>;
        recordShard.core = { ...core, threads: rows };
        writePersistedSession(root, recordShard);

        for (const thread of threads) {
            if (!thread.hasTranscript) {
                // Torn state: no shard file at all, so the reader puts the row back exactly as
                // it came in. `force` because the file usually is not there.
                fs.rmSync(harnessThreadFileOf(root, record.id, thread.id), { force: true });
                continue;
            }

            writePersistedThread(root, record.id, thread.id, {
                version: 2,
                sessionId: record.id,
                id: thread.id,
                messages: thread.messages
            });
        }
    }
};

// ---------------------------------------------------------------------------
// Directory pins
// ---------------------------------------------------------------------------

// Every staging file (`*.tmp`) anywhere under `<root>/harness`, recursively.
//
// The v1 "the harness directory contains exactly `['state.json']`" pin was really two
// claims: the canonical document is there, and a crash mid-write left no
// `state.json.<pid>.<n>.tmp` behind. In v2 the directory legitimately holds `index.json`
// plus `sessions/` (and `agents.json` once an operator edits an agent), so the layout
// half is asserted separately and this helper carries the "no staging leftovers" half —
// which now has to cover the shard directories too, since shards are committed with the
// same staging+fsync+rename sequence (./persistence.ts:2486 `writeHarnessShardFile`).
export const listHarnessStagingLeftovers = (root: string): string[] => {
    const directory = harnessDirectoryOf(root);
    if (!fs.existsSync(directory)) return [];

    const found: string[] = [];
    const walk = (current: string, prefix: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;

            if (entry.isDirectory()) {
                walk(path.join(current, entry.name), relative);
                continue;
            }

            if (entry.name.endsWith('.tmp')) found.push(relative);
        }
    };

    walk(directory, '');

    return found;
};

// Sorted immediate entries of `<root>/harness` — the layout half of the pin above.
export const listHarnessDirectory = (root: string): string[] => fs.readdirSync(harnessDirectoryOf(root)).sort();

// Sorted thread shard file names of a session (`['<threadId>.json', ...]`), used by pins
// that assert the shard set matches the session's `core.threads[]` rows.
export const listPersistedThreadFiles = (root: string, sessionId: string): string[] => {
    const directory = path.join(
        harnessDirectoryOf(root),
        HARNESS_SESSIONS_DIRECTORY,
        sessionId,
        HARNESS_THREAD_DIRECTORY
    );

    if (!fs.existsSync(directory)) return [];

    return fs.readdirSync(directory).sort();
};

// T5: the durable knowledge store, pinned against REAL files.
//
// What this file proves, in the order the brief lists it:
//   1. a cold start from an empty root is an empty store that writes NOTHING (no directory,
//      no report beyond `loaded`, no `dispose` write);
//   2. a written store reloaded by a SECOND store instance over the same root reproduces the
//      articles byte-for-byte — the "knowledge persists outside the session" proof, run in
//      both directions (instance 2 also writes, instance 3 reads that back);
//   3. removing an article erases its file (and the index row goes with it);
//   4. the interval gate: five mutations cost ONE write, not five, and the write count is
//      counted from the store's own `commit` reports (the ./persistence-coalescing.test.ts
//      idiom of asserting the write count rather than the wall clock). Those scenarios pass an
//      explicit `intervalMs` — the DEFAULT is 0 (item 14), so a gate test that omitted it would
//      be testing the no-gate path;
//   5. the trailing timer is armed ONCE per gated burst, with the exact remaining delay, is
//      `unref()`'d, fires, and is never re-armed after it wrote;
//   6. `flush()` is a coalescing, idempotent durability barrier;
//   7. a failing write is REPORTED, keeps the article dirty, and the next commit retries it —
//      the file that was already there is untouched (the canonical file is never unlinked);
//   8. corrupt JSON, an unknown `version`, and a file whose name and content disagree on the
//      id all throw naming the path;
//   9. a file whose name is not a uuid is skipped AS A DIAGNOSTIC (a stranger's `notes.json`
//      must not take the base down), while the staging family is ignored silently;
//   10. an index that disagrees with the files is REPORTED, and the FILE is what loads;
//   11. an out-of-band byte edit heals on a forced commit (the digest+witness gate);
//   12. a traversal id is refused before it is ever path-joined;
//   13. `dispose()` flushes, clears the timer, stops tracking mutations, and REFUSES a later
//       `commit()`/`flush()` instead of answering a zero-work success (T15/F4);
//   14. the DEFAULT window is 0: a mutation is durable with no `commit()`, no `flush()`, and no
//       trailing timer armed at all — while the gate still coalesces one burst into one pass;
//   15. the repair pass (`commit({ force: true })`) answers `report.due` — the symmetric
//       difference over article ids, keyed off the engine — and ACTS on all three findings: an
//       out-of-band CREATE is ADOPTED into the engine (never erased), a hand-deleted file is
//       rewritten, and a removal that never landed is erased;
//   16. a file this store CANNOT read is reported and left in place (data loss is not a repair),
//       and the next `load` is loud about the same path;
//   17. `diagnostics()` RETAINS the divergences the store has seen and not repaired, and a forced
//       pass that repaired everything clears the set as one unit;
//   18. a caller that asks for work gets the report of a pass that DID work: a forced request that
//       joins a plain in-flight pass waits for it and then runs its own, and a durability barrier
//       answers with the pass that moved bytes rather than the idle one that followed it;
//   19. the staging family is `state.json.knowledge.<pid>.<n>.tmp` — the pid is IN the owner token,
//       which is what keeps a second PROCESS out of a shared stage name (T15/F3), and an explicit
//       `owner` is still honoured verbatim;
//   20. the single-writer boundary, PINNED NOT FIXED (T15/F2): two live stores over one root each
//       hold a valid `expects` token for one article, both commit, and one edit is gone — no
//       refusal, no `failure`, no `diagnostics()` line. A lost `index.json` row, by contrast, is
//       TOLERATED because the files are the record: the next load reads both articles back (and
//       reports the accelerator), and a forced pass ADOPTS the peer's file.
//
// Why the numbers are exact: the clock is pinned (the `pinTaskClock` policy of
// ./persistence.test.ts:335-342 — `Date.now` only, so `setTimeout` stays real and the deferred
// write still happens) and the engine's uuid source is pinned, so every file name, every
// `createdAt`, and every index `savedAt` is a literal this file can spell. One caveat that
// belongs here rather than in a comment at the assertion: `create` mints one id PER PARAGRAPH
// and only then the article's, so a one-paragraph create's article id is the SECOND id the
// pinned source hands out — the ids below are spelled with that in mind.
//
// Why real files under the REPO-ROOT `Temp/`: durability is the subject, and an in-memory fake
// proves nothing about `rename` or `fsync`. `mkdtemp` under `Temp/` (resolved through
// `import.meta.url`, never `process.cwd()`, never OS `/tmp`) is the same footing
// ./persistence-coalescing.test.ts:47-61 and ../tools/files/edit.test.ts:65 use.
//
// Cross-references:
//   - ./knowledge-file-store.ts       — the module under test (its header states the rules)
//   - ./persistence.ts                — `writeHarnessDatabaseFile`/`commitHarnessFile` (the
//                                       commit every byte goes through), `harnessShardStampOf`
//   - ./sessions.ts                   — `checkpoint`/`scheduleCheckpoint`/`clearCheckpointTimer`
//                                       (the committer whose gate and trailing write are pinned here)
//   - ../core/knowledge.ts            — the engine (its `now`/`ids` seams make these asserts exact)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createKnowledgeEngine } from '../core/knowledge';
import type { KnowledgeArticle, KnowledgeEngine } from '../types';
import {
    HARNESS_KNOWLEDGE_INDEX_FILE,
    HARNESS_KNOWLEDGE_INTERVAL_MS,
    HARNESS_KNOWLEDGE_VERSION,
    knowledgeArticleFileOf,
    knowledgeDirectoryOf,
    knowledgeIndexFileOf,
    loadKnowledgeFileStore
} from './knowledge-file-store';
// The staging FAMILY name comes from the persistence layer's own constant, not a literal spelled
// here: `writeHarnessDatabaseFile` stages under `HARNESS_DATABASE_FILE` whatever the canonical file
// is (./persistence.ts:2165-2175), and pinning the real prefix is what makes the T15/F3 assertion
// about the OWNER meaningful instead of restating a string.
import { HARNESS_DATABASE_FILE } from './persistence';
import type {
    KnowledgeCommitReport,
    KnowledgeStore,
    KnowledgeStoreReportEvent
} from './knowledge-file-store';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const roots: string[] = [];

// One throwaway DATABASE root per scenario — the value a deployment passes as `root`, so the
// store itself has to derive `harness/knowledge/` from it.
const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-knowledge-${label}-`));

    roots.push(root);

    return root;
};

afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// The pinned epoch: `Date.now()` and the engine clock are held at the SAME value, so a stored
// `createdAt` and the index `savedAt` are the same literal, and the interval gate sees an
// unmoving clock (every mutation after the first is therefore unambiguously INSIDE the window).
const EPOCH_MS = Date.UTC(2026, 10, 18, 12, 0, 0);
const EPOCH_ISO = new Date(EPOCH_MS).toISOString();

const pinClock = (): ((next: number) => void) => {
    let value = EPOCH_MS;

    vi.spyOn(Date, 'now').mockImplementation(() => value);

    return (next: number) => {
        value = next;
    };
};

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

// A fixed uuid list: 64 is more than any scenario mints (one id per article PLUS one per
// paragraph), and running out throws instead of handing back a duplicate id — a duplicate would
// quietly merge two articles and make a byte assertion meaningless. `offset` lets a SECOND store
// in one scenario mint ids the first one never used, which is what keeps the merged ordering of a
// reload assertion exact instead of dependent on a random uuid's sort position.
const uuidList = (count = 64, offset = 0): string[] =>
    Array.from(
        { length: count },
        (_, index) => `00000000-0000-4000-8000-${String(index + offset).padStart(12, '0')}`
    );

const pinnedEngine = (ids: string[]): KnowledgeEngine => {
    let next = 0;

    return createKnowledgeEngine({
        now: () => EPOCH_MS,
        ids: () => {
            const id = ids[next];

            if (id === undefined) throw new Error(`the test knowledge id source ran out after ${next} ids.`);

            next += 1;

            return id;
        }
    });
};

// One `create` per call, so a scenario's article count is spelled in the scenario.
const createArticle = (
    engine: KnowledgeEngine,
    title: string,
    content: string = `Body of ${title}.`
): KnowledgeArticle => engine.execute({ verb: 'create', title, tags: ['ops'], content: [content] }).article;

const articleIds = (engine: KnowledgeEngine): string[] =>
    engine.snapshot().articles.map((article) => article.id);

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

const articleFileOf = (root: string, id: string): string => knowledgeArticleFileOf(root, id);

// The canonical bytes the store writes for one article, spelled independently here so a byte
// assertion means "these are the bytes", not "the store agrees with itself".
const articleBytesOf = (article: KnowledgeArticle): string =>
    JSON.stringify({ version: HARNESS_KNOWLEDGE_VERSION, article }, null, 2);

// Polls for the DEFERRED commit instead of sleeping a guessed amount, counted in iterations
// because a pinned `Date.now` never advances (the `waitForDocument` policy of
// ./persistence.test.ts:353-375). Running out is the failure: it means the trailing write
// never happened, which is the bound the gate promises.
const settle = async (predicate: () => boolean, budgetMs = 4_000): Promise<void> => {
    const attempts = Math.ceil(budgetMs / 10);

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (predicate()) return;

        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`the deferred knowledge commit did not land within ${budgetMs} ms.`);
};

// The timer seam. `setTimeout` is wrapped (not faked) so the deferred write still runs on the
// real clock, while the test learns the delay the store asked for and whether the handle was
// `unref()`'d — the two properties `scheduleCheckpoint` (./sessions.ts:6272-6295) claims.
type ArmedTimer = { delay: number; unrefed: boolean };

const watchTimers = (): ArmedTimer[] => {
    const realSetTimeout = globalThis.setTimeout;
    const armed: ArmedTimer[] = [];

    const replacement = (callback: () => void, delay?: number): ReturnType<typeof setTimeout> => {
        const handle = realSetTimeout(callback, delay) as unknown as { unref?: () => unknown };
        const record: ArmedTimer = { delay: delay ?? 0, unrefed: false };

        armed.push(record);

        const unref = handle.unref;

        if (typeof unref === 'function') {
            handle.unref = (): unknown => {
                record.unrefed = true;

                return unref.call(handle);
            };
        }

        return handle as unknown as ReturnType<typeof setTimeout>;
    };

    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        replacement as unknown as (callback: () => void, ms?: number) => ReturnType<typeof setTimeout>
    );

    return armed;
};

// Every `commit` report the store emitted, in order — the write count, straight from the
// store's own accounting.
const commitEvents = (events: KnowledgeStoreReportEvent[]): KnowledgeCommitReport[] =>
    events.filter((event) => event.kind === 'commit').map((event) => (event as { report: KnowledgeCommitReport }).report);

// The same events, narrowed, for the assertions that need the pass's DIAGNOSTICS as well as its
// report (`kind` is a discriminant, so the predicate is what lets the union resolve).
const commitPasses = (events: KnowledgeStoreReportEvent[]) =>
    events.filter(
        (event): event is Extract<KnowledgeStoreReportEvent, { kind: 'commit' }> => event.kind === 'commit'
    );

const idleReport: KnowledgeCommitReport = { written: [], erased: [], skipped: [], bytes: 0, at: EPOCH_ISO };

// ---------------------------------------------------------------------------
// 1. Cold start
// ---------------------------------------------------------------------------

describe('knowledge file store — cold start', () => {
    it('reads an empty root as an empty store, creates nothing, and reports the load', async () => {
        pinClock();

        const root = tempRoot('cold');
        const events: KnowledgeStoreReportEvent[] = [];
        const store = await loadKnowledgeFileStore({ root, report: (event) => events.push(event) });

        expect(store.root).toBe(path.resolve(root));
        // The namespace is derived from the DATABASE root, not handed in — and it is the SAME
        // `harness/` namespace the sessions live in, one level deeper.
        expect(store.directory).toBe(path.join(path.resolve(root), 'harness', 'knowledge'));
        expect(store.directory).toBe(knowledgeDirectoryOf(root));
        expect(knowledgeIndexFileOf(root)).toBe(path.join(store.directory, HARNESS_KNOWLEDGE_INDEX_FILE));

        expect(store.engine.snapshot()).toEqual({ storeRev: 0, articles: [] });
        // The implied index carries the watermark too (the one engine field an article file has
        // nowhere to put), so an index the store built itself is the same shape as one it wrote.
        expect(store.readIndex()).toEqual({
            version: HARNESS_KNOWLEDGE_VERSION,
            savedAt: EPOCH_ISO,
            articles: [],
            storeRev: 0
        });

        // A missing directory is the first-run case: nothing was read, and NOTHING was written.
        expect(fs.existsSync(store.directory)).toBe(false);
        expect(fs.existsSync(knowledgeIndexFileOf(root))).toBe(false);

        expect(events).toEqual([
            { kind: 'loaded', directory: store.directory, articles: 0, storeRev: 0, diagnostics: [] }
        ]);

        // Nothing owed, so shutdown performs no write either.
        await expect(store.dispose()).resolves.toBeUndefined();
        expect(fs.existsSync(store.directory)).toBe(false);
        expect(fs.readdirSync(root)).toEqual([]);
    });

    it('refuses a blank root instead of silently serving an in-memory knowledge base', async () => {
        const failure = await loadKnowledgeFileStore({ root: '   ' }).then(
            () => undefined,
            (error: unknown) => error as Error
        );

        expect(failure).toBeInstanceOf(Error);
        expect(failure?.name).toBe('HarnessPersistenceError');
        expect(failure?.message).toContain('non-empty string');
    });
});

// ---------------------------------------------------------------------------
// 2. The write path, byte for byte
// ---------------------------------------------------------------------------

describe('knowledge file store — the article file format', () => {
    it('writes one article per file plus the index row, with no staging leftovers and nothing outside harness/knowledge', async () => {
        pinClock();

        const root = tempRoot('format');
        const events: KnowledgeStoreReportEvent[] = [];
        const engine = pinnedEngine(uuidList());
        // `intervalMs: 0` disables the gate: these scenarios care about content, and `flush()`
        // below still makes the write synchronous-with-the-assertion.
        const store = await loadKnowledgeFileStore({
            root,
            engine,
            intervalMs: 0,
            report: (event) => events.push(event)
        });

        const article = createArticle(engine, 'Ship notes', 'Docking is a two-step.');

        expect(article.createdAt).toBe(EPOCH_ISO);
        expect(article.updatedAt).toBe(EPOCH_ISO);
        expect(article.rev).toBe(1);
        // `...0000` is the PARAGRAPH's id: `create` mints one id per paragraph and only then the
        // article's, so the article of a one-paragraph create is the SECOND id the pinned source
        // hands out. Spelled here rather than read off the run, so a change in the engine's minting
        // order shows up as a failed assertion instead of a moved expectation.
        expect(article.id).toBe('00000000-0000-4000-8000-000000000001');

        const report = await store.flush();

        expect(report.written).toEqual([article.id]);
        expect(report.erased).toEqual([]);
        expect(report.skipped).toEqual([]);
        expect(report.at).toBe(EPOCH_ISO);
        expect(report.failure).toBeUndefined();

        const file = articleFileOf(root, article.id);
        const indexFile = knowledgeIndexFileOf(root);

        expect(fs.readFileSync(file, 'utf8')).toBe(articleBytesOf(article));
        expect(readJson(file)).toEqual({ version: HARNESS_KNOWLEDGE_VERSION, article });
        expect(fs.readFileSync(indexFile, 'utf8')).toBe(
            JSON.stringify(
                {
                    version: HARNESS_KNOWLEDGE_VERSION,
                    savedAt: EPOCH_ISO,
                    articles: [{ id: article.id, title: 'Ship notes', updatedAt: EPOCH_ISO, file: `${article.id}.json` }],
                    // The engine's mutation counter, and the only engine number an article file has
                    // no place to carry (see `KnowledgeDirectoryIndex.storeRev`).
                    storeRev: 1
                },
                null,
                2
            )
        );

        // The report bills exactly the bytes that reached the write path — both files.
        expect(report.bytes).toBe(
            Buffer.byteLength(fs.readFileSync(file, 'utf8'), 'utf8') +
                Buffer.byteLength(fs.readFileSync(indexFile, 'utf8'), 'utf8')
        );

        // `readIndex()` answers what `index.json` says, detached.
        expect(store.readIndex().articles).toEqual([
            { id: article.id, title: 'Ship notes', updatedAt: EPOCH_ISO, file: `${article.id}.json` }
        ]);
        store.readIndex().articles[0].title = 'mutated';
        expect(store.readIndex().articles[0].title).toBe('Ship notes');

        // Exactly the two files: no `.tmp` staging leftover survived the commit.
        expect(fs.readdirSync(store.directory).sort()).toEqual([`${article.id}.json`, HARNESS_KNOWLEDGE_INDEX_FILE]);

        // And the store stayed inside its own directory: the DATABASE root gained one child,
        // the `harness/` namespace gained one child, and neither the harness header, nor
        // `sessions/`, nor `agents.json` was created or touched.
        expect(fs.readdirSync(root)).toEqual(['harness']);
        expect(fs.readdirSync(path.join(root, 'harness'))).toEqual(['knowledge']);

        expect(commitEvents(events)).toHaveLength(1);

        await expect(store.dispose()).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 3. Persistence across store instances
// ---------------------------------------------------------------------------

describe('knowledge file store — persistence outside the session', () => {
    it('reloads the same base in a second store instance byte-for-byte, and reloads the second one too', async () => {
        pinClock();

        const root = tempRoot('reload');
        const first = await loadKnowledgeFileStore({ root, engine: pinnedEngine(uuidList()), intervalMs: 0 });

        const anchor = createArticle(first.engine, 'Anchor', 'Read this first.');
        const other = createArticle(first.engine, 'Other', 'Read this second.');

        await first.flush();

        const files = [anchor.id, other.id].map((id) => articleFileOf(root, id));
        const bytes = files.map((file) => fs.readFileSync(file, 'utf8'));
        const firstSnapshot = first.engine.snapshot();

        expect(firstSnapshot.articles.map((article) => article.title)).toEqual(['Anchor', 'Other']);

        // A SECOND store over the same root, with its own engine — the position the next
        // session's harness is in. The article ids, bodies, revs and stamps all come off disk; the
        // engine contributes nothing (it is empty before the load), and its id source starts at an
        // offset so anything it mints cannot collide with what is on disk.
        const second = await loadKnowledgeFileStore({
            root,
            engine: pinnedEngine(uuidList(64, 4)),
            intervalMs: 0
        });

        expect(second.engine.snapshot()).toEqual(firstSnapshot);
        expect(articleIds(second.engine)).toEqual([anchor.id, other.id]);
        expect(second.engine.read({ id: other.id }).paragraphs).toEqual(
            first.engine.read({ id: other.id }).paragraphs
        );
        expect(second.readIndex()).toEqual(first.readIndex());

        // Loading wrote NOTHING: the bytes are exactly what the first store committed.
        expect(files.map((file) => fs.readFileSync(file, 'utf8'))).toEqual(bytes);
        expect(await second.commit()).toEqual(idleReport);

        // The second instance can also write, and a third instance reads that back — the loop
        // closes in both directions, which is what "persistent outside the session" has to mean.
        const third = createArticle(second.engine, 'Written by the second store');

        // The second store's source starts at offset 4, and `create` takes the paragraph id before
        // the article id — so its article is `...0005`, not `...0004`.
        expect(third.id).toBe('00000000-0000-4000-8000-000000000005');

        await second.flush();

        const thirdFile = articleFileOf(root, third.id);

        expect(fs.readFileSync(thirdFile, 'utf8')).toBe(articleBytesOf(third));

        const reloaded = await loadKnowledgeFileStore({ root, intervalMs: 0 });

        expect(reloaded.engine.snapshot()).toEqual(second.engine.snapshot());
        expect(reloaded.engine.articles().map((summary) => summary.title).sort()).toEqual([
            'Anchor',
            'Other',
            'Written by the second store'
        ]);

        await expect(first.dispose()).resolves.toBeUndefined();
        await expect(second.dispose()).resolves.toBeUndefined();
        await expect(reloaded.dispose()).resolves.toBeUndefined();
    });

    it('erases the article file when the article is removed, and drops its index row', async () => {
        pinClock();

        const root = tempRoot('remove');
        const store = await loadKnowledgeFileStore({ root, engine: pinnedEngine(uuidList()), intervalMs: 0 });

        const kept = createArticle(store.engine, 'Kept');
        const gone = createArticle(store.engine, 'Gone');

        await store.flush();

        const indexBefore = fs.readFileSync(knowledgeIndexFileOf(root), 'utf8');

        store.engine.execute({ verb: 'remove', id: gone.id });

        const report = await store.flush();

        // A removal costs no payload bytes: only the index was written.
        expect(report).toEqual({
            written: [],
            erased: [gone.id],
            skipped: [],
            bytes: Buffer.byteLength(fs.readFileSync(knowledgeIndexFileOf(root), 'utf8'), 'utf8'),
            at: EPOCH_ISO
        });

        expect(fs.existsSync(articleFileOf(root, gone.id))).toBe(false);
        expect(fs.existsSync(articleFileOf(root, kept.id))).toBe(true);
        expect(fs.readdirSync(store.directory).sort()).toEqual([`${kept.id}.json`, HARNESS_KNOWLEDGE_INDEX_FILE]);

        // The removal was durable: a fresh store never saw the article.
        const reloaded = await loadKnowledgeFileStore({ root, intervalMs: 0 });

        expect(articleIds(reloaded.engine)).toEqual([kept.id]);
        expect(reloaded.readIndex().articles.map((entry) => entry.id)).toEqual([kept.id]);
        // The watermark came off the index, not off the surviving article's own `rev` (which is 1):
        // the reload resumes at 3 committed operations, exactly where the writer stopped.
        expect(reloaded.engine.snapshot().storeRev).toBe(3);

        // An empty knowledge base commits as an empty index, and erases every file.
        store.engine.execute({ verb: 'remove', id: kept.id });
        await store.flush();

        expect(fs.readdirSync(store.directory)).toEqual([HARNESS_KNOWLEDGE_INDEX_FILE]);
        expect(readJson(knowledgeIndexFileOf(root))).toEqual({
            version: HARNESS_KNOWLEDGE_VERSION,
            savedAt: EPOCH_ISO,
            articles: [],
            // Four committed operations (two creates, two removes). The counter SURVIVES an empty
            // base: it is the engine's mutation count, not a function of what is stored, and an
            // index that dropped it would let a reload restart the count behind the files.
            storeRev: 4
        });
        expect(indexBefore).not.toBe(fs.readFileSync(knowledgeIndexFileOf(root), 'utf8'));

        const empty = await loadKnowledgeFileStore({ root, intervalMs: 0 });

        expect(empty.engine.snapshot()).toEqual({ storeRev: 0, articles: [] });

        await expect(store.dispose()).resolves.toBeUndefined();
        await expect(reloaded.dispose()).resolves.toBeUndefined();
        await expect(empty.dispose()).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 4-5. The committer: the gate, and the trailing write
// ---------------------------------------------------------------------------

describe('knowledge file store — the commit gate', () => {
    it('writes ONCE for a burst of five mutations, not five times, and nothing at all before the first await', async () => {
        pinClock();

        const root = tempRoot('gate');
        const events: KnowledgeStoreReportEvent[] = [];
        const engine = pinnedEngine(uuidList());
        const store = await loadKnowledgeFileStore({
            root,
            engine,
            intervalMs: 400,
            report: (event) => events.push(event)
        });

        // Five committed mutations in one tick. The cold-start anchor armed one pass on a
        // microtask, so up to the first `await` NOT ONE byte has reached the disk: the gate held
        // the other four, and the fifth is the pass that has not run yet.
        const ids = Array.from({ length: 5 }, (_, index) => createArticle(engine, `Article ${index}`).id);

        expect(fs.existsSync(store.directory)).toBe(false);
        expect(commitEvents(events)).toHaveLength(0);

        // Joining the pass that is already in flight is what `commit()` does — one report for
        // the whole burst.
        const report = await store.commit();

        expect(report.written).toEqual([...ids].sort());
        expect(report.skipped).toEqual([]);
        expect(report.erased).toEqual([]);

        expect(commitEvents(events)).toHaveLength(1);
        expect(commitEvents(events)[0].written).toEqual([...ids].sort());

        // Five articles, one pass: the write count is the report count, not the mutation count.
        expect(fs.readdirSync(store.directory).length).toBe(6);
        expect(fs.existsSync(store.directory)).toBe(true);

        await expect(store.dispose()).resolves.toBeUndefined();
        expect(commitEvents(events)).toHaveLength(1);
    });

    it('arms ONE unref-ed trailing timer for the rest of the window, and its write covers the gated burst', async () => {
        pinClock();

        const root = tempRoot('trailing');
        const events: KnowledgeStoreReportEvent[] = [];
        const engine = pinnedEngine(uuidList());
        const store = await loadKnowledgeFileStore({
            root,
            engine,
            intervalMs: 400,
            report: (event) => events.push(event)
        });

        const first = createArticle(engine, 'Committed immediately');

        // The anchor write, awaited — the window now starts at the pinned epoch.
        expect((await store.flush()).written).toEqual([first.id]);

        const armed = watchTimers();
        const before = commitEvents(events).length;

        const gated = Array.from({ length: 4 }, (_, index) => createArticle(engine, `Deferred ${index}`).id);

        // The whole burst shares ONE timer: armed once, for exactly the rest of the window
        // (the clock is frozen, so the elapsed part is 0 and the delay is the interval itself),
        // and `unref()`-ed because a pending commit must not hold the process open.
        expect(armed.map((timer) => timer.delay)).toEqual([400]);
        expect(armed.map((timer) => timer.unrefed)).toEqual([true]);

        // Nothing was written for those four mutations.
        expect(commitEvents(events)).toHaveLength(before);
        expect(fs.readdirSync(store.directory).sort()).toEqual([`${first.id}.json`, HARNESS_KNOWLEDGE_INDEX_FILE]);

        // The trailing write runs UNCONDITIONALLY when the timer fires (re-testing the gate with
        // a frozen clock would drop the change forever, ./sessions.ts:6265-6268).
        const pending = new Set(gated);

        await settle(() => [...pending].every((id) => fs.existsSync(articleFileOf(root, id))));

        const eventsAfter = commitEvents(events);

        expect(eventsAfter).toHaveLength(before + 1);
        expect(eventsAfter[eventsAfter.length - 1].written).toEqual([...gated].sort());
        expect(eventsAfter[eventsAfter.length - 1].failure).toBeUndefined();

        // One burst, one timer: the deferred write did not re-arm it.
        expect(armed.filter((timer) => timer.delay >= 400)).toHaveLength(1);

        await expect(store.dispose()).resolves.toBeUndefined();
    });

    // THE DEFAULT WINDOW IS ZERO — pinned by not naming an interval at all. The unit of work here
    // is one article edit per tool call, so durability has no reason to wait for a batch, and the
    // property the knowledge tool needs is "durable before the next call".
    it('at the default window (0) commits on the mutation itself, with no timer armed at all', async () => {
        pinClock();

        const root = tempRoot('zero');
        const events: KnowledgeStoreReportEvent[] = [];
        const engine = pinnedEngine(uuidList());
        const armed = watchTimers();
        // No `intervalMs`: this scenario is the deployment's default path, not a test seam.
        const store = await loadKnowledgeFileStore({ root, engine, report: (event) => events.push(event) });

        // The exported default is the whole policy statement: zero, because one article edit per
        // tool call is already a settled unit of work. It is NOT inherited from the session
        // recorder — `VIEW_CHECKPOINT_INTERVAL_MS` is 2 s (./sessions.ts:523), a window for
        // per-token churn — so this figure stands on its own reasoning, and the two are meant to
        // differ (see the header at ./knowledge-file-store.ts:149-157).
        expect(HARNESS_KNOWLEDGE_INTERVAL_MS).toBe(0);

        // Two mutations in one tick. Neither is awaited, and no `commit()`/`flush()` is called: the
        // bytes have to arrive on their own.
        const first = createArticle(engine, 'Durable without asking');
        const second = createArticle(engine, 'Same burst, same pass');

        await settle(() => fs.existsSync(articleFileOf(root, first.id)));
        await settle(() => fs.existsSync(knowledgeIndexFileOf(root)));

        // No trailing timer: at a zero window there is no rest-of-window to wait for. The only
        // `setTimeout` calls in this scenario are `settle`'s own 10 ms polls, so "nothing from the
        // store" is an exact statement about the recorded delays, not a smoke check.
        expect(armed.filter((timer) => timer.delay !== 10)).toEqual([]);

        // The GATE still earns its keep at zero: the two notifications became ONE pass, because the
        // second caller joined the pass the first one armed. Two articles, one report.
        const passes = commitEvents(events);

        expect(passes).toHaveLength(1);
        expect(passes[0].written).toEqual([first.id, second.id].sort());
        expect(passes[0].erased).toEqual([]);
        expect(passes[0].skipped).toEqual([]);
        expect(passes[0].failure).toBeUndefined();

        // And the mutation really is durable: a store that knows nothing about this one reads both
        // articles back, watermark included.
        const reloaded = await loadKnowledgeFileStore({ root });

        expect(reloaded.engine.snapshot()).toEqual(store.engine.snapshot());
        expect(reloaded.diagnostics()).toEqual([]);

        await expect(store.dispose()).resolves.toBeUndefined();
        await expect(reloaded.dispose()).resolves.toBeUndefined();
    });

    // A FORCED request must not be answered with a plain pass's shallow answer: the plain pass never
    // looked at the directory, so it cannot say the base is consistent. This pins the rule that the
    // forced caller waits for the pass it joined and then runs its own.
    it('answers a forced request with its own pass, even when a plain pass was already in flight', async () => {
        pinClock();

        const root = tempRoot('join-forced');
        const engine = pinnedEngine(uuidList());
        const store = await loadKnowledgeFileStore({ root, engine, intervalMs: 0 });

        const article = createArticle(engine, 'Plain');

        // ONE tick: a plain pass is already in flight (armed by the mutation notification), and the
        // forced request arrives while it runs.
        const [plain, forced] = await Promise.all([store.commit(), store.commit({ force: true })]);

        // The plain caller's report is the pass that MOVED THE BYTES — that is the report a caller
        // of `commit()` is owed, and it is not the idle answer of a later pass.
        expect(plain.written).toEqual([article.id]);
        expect(plain.failure).toBeUndefined();

        // The forced caller got a report that SURVEYED the directory: a plain pass can never answer
        // a forced request, so either the pass it joined was a survey, or the survey debt armed the
        // next pass and it joined that one. The one report shape it can never be handed is a plain
        // one, which is what `due` being ABSENT would mean.
        expect(forced.due).toEqual({ created: [], modified: [], deleted: [] });

        // The survey cost no write it did not have to: the article's bytes matched the engine, and
        // the index was already current (`at` is the pinned epoch, so the re-stamp is byte-identical
        // and the digest+witness gate skips it) — a clean forced pass bills ZERO bytes.
        expect(forced.written).toEqual([]);
        expect(forced.bytes).toBe(0);
        expect(forced.failure).toBeUndefined();
        expect(store.diagnostics()).toEqual([]);

        await expect(store.dispose()).resolves.toBeUndefined();
    });

    it('coalesces concurrent commits and repeated flushes into one write pass', async () => {
        pinClock();

        const root = tempRoot('flush');
        const events: KnowledgeStoreReportEvent[] = [];
        const engine = pinnedEngine(uuidList());
        const store = await loadKnowledgeFileStore({
            root,
            engine,
            intervalMs: 0,
            report: (event) => events.push(event)
        });

        const ids = [createArticle(engine, 'First').id, createArticle(engine, 'Second').id];

        // Two callers, one barrier: they get the SAME report object, not two passes.
        const [one, two] = await Promise.all([store.flush(), store.flush()]);

        expect(one).toBe(two);
        expect(one.written).toEqual([...ids].sort());

        // Idempotent by design: the store is quiet, so the barrier costs zero syscalls.
        const three = await store.flush();

        expect(three).toEqual(idleReport);
        expect((await store.commit()).bytes).toBe(0);

        const file = articleFileOf(root, ids[0]);
        const bytes = fs.readFileSync(file, 'utf8');

        expect(await store.flush()).toEqual(idleReport);
        expect(fs.readFileSync(file, 'utf8')).toBe(bytes);

        expect(commitEvents(events)).toHaveLength(1);

        await expect(store.dispose()).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 6. A failing write is reported, not fatal
// ---------------------------------------------------------------------------

describe('knowledge file store — write failure', () => {
    it('reports the failure, keeps the article dirty, leaves the durable file alone, and retries', async () => {
        pinClock();

        const root = tempRoot('failure');
        const events: KnowledgeStoreReportEvent[] = [];
        const engine = pinnedEngine(uuidList());
        // A window too long to fire inside the test: the only pass is the one this test awaits.
        const store = await loadKnowledgeFileStore({
            root,
            engine,
            intervalMs: 60_000,
            report: (event) => events.push(event)
        });

        const article = createArticle(store.engine, 'Retry me', 'Version one.');

        await store.flush();

        const file = articleFileOf(root, article.id);
        const durable = fs.readFileSync(file, 'utf8');

        const modified = store.engine
            .execute({ verb: 'modify', id: article.id, setParagraphs: [{ id: article.content[0].id, text: 'Version two.' }] })
            .article;

        // The mutation is gated (frozen clock, huge window), so the failing pass below is the
        // only writer in this scenario.
        const openSync = vi.spyOn(fs, 'openSync').mockImplementation(() => {
            throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        });

        const failed = await store.commit();

        openSync.mockRestore();

        expect(failed.written).toEqual([]);
        expect(failed.erased).toEqual([]);
        expect(failed.skipped).toEqual([]);
        expect(failed.bytes).toBe(0);
        // The report names the file an operator has to act on.
        expect(failed.failure).toContain(file);
        expect(failed.failure).toContain('ENOSPC');

        // The change is NOT lost: the engine holds the new text, and the file still holds the
        // OLD bytes (the canonical file was never unlinked, and the staging file was cleaned up).
        expect(store.engine.read({ id: article.id }).paragraphs?.[0].text).toBe('Version two.');
        expect(fs.readFileSync(file, 'utf8')).toBe(durable);
        expect(readJson(knowledgeIndexFileOf(root))).toEqual({
            version: HARNESS_KNOWLEDGE_VERSION,
            savedAt: EPOCH_ISO,
            // The index was NOT rewritten by a failing pass: it must not promise an article whose
            // file is not durable, and it does not claim a watermark the files do not back either
            // (`storeRev` stays at the one committed operation, not the modify that failed).
            articles: [{ id: article.id, title: 'Retry me', updatedAt: EPOCH_ISO, file: `${article.id}.json` }],
            storeRev: 1
        });

        expect(events.filter((event) => event.kind === 'failure')).toHaveLength(1);

        // The article stayed dirty, so the next commit retries it — and heals the index too.
        const retry = await store.flush();

        expect(retry.written).toEqual([article.id]);
        expect(retry.failure).toBeUndefined();
        expect(fs.readFileSync(file, 'utf8')).toBe(articleBytesOf(modified));
        expect(store.engine.snapshot().articles).toEqual(await (async () => {
            const reload = await loadKnowledgeFileStore({ root, intervalMs: 0 });
            const loaded = reload.engine.snapshot().articles;
            await reload.dispose();

            return loaded;
        })());

        await expect(store.dispose()).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 7-9. Load refuses a base it cannot understand, and reports what it skips
// ---------------------------------------------------------------------------

describe('knowledge file store — load refuses corruption', () => {
    // Seeds a one-article store and hands back its root plus the article.
    const seed = async (label: string): Promise<{ root: string; article: KnowledgeArticle }> => {
        const root = tempRoot(label);
        const store = await loadKnowledgeFileStore({ root, engine: pinnedEngine(uuidList()), intervalMs: 0 });
        const article = createArticle(store.engine, 'Seeded', 'Durable body.');

        await store.flush();
        await store.dispose();

        return { root, article };
    };

    const rejected = async (root: string): Promise<Error> =>
        loadKnowledgeFileStore({ root }).then(
            () => {
                throw new Error('the store loaded a base it should have refused.');
            },
            (error: unknown) => error as Error
        );

    it('throws naming the article file whose JSON is corrupt', async () => {
        pinClock();

        const { root, article } = await seed('corrupt');
        const file = articleFileOf(root, article.id);

        fs.writeFileSync(file, '{"version": 1, "article": {');

        const failure = await rejected(root);

        expect(failure.name).toBe('HarnessPersistenceError');
        expect(failure.message).toContain(file);
        expect(failure.message).toContain('not valid JSON');
    });

    it('throws naming the file whose version this build does not read', async () => {
        const { root, article } = await seed('version');
        const file = articleFileOf(root, article.id);

        fs.writeFileSync(file, JSON.stringify({ version: HARNESS_KNOWLEDGE_VERSION + 1, article }, null, 2));

        const failure = await rejected(root);

        expect(failure.name).toBe('HarnessPersistenceError');
        expect(failure.message).toContain(file);
        expect(failure.message).toContain(`version ${HARNESS_KNOWLEDGE_VERSION + 1}`);
        expect(failure.message).toContain(`version ${HARNESS_KNOWLEDGE_VERSION} only`);
    });

    it('throws naming the index when its version or its JSON is unusable', async () => {
        const { root } = await seed('index-version');
        const indexFile = knowledgeIndexFileOf(root);

        fs.writeFileSync(
            indexFile,
            JSON.stringify({ version: 99, savedAt: EPOCH_ISO, articles: [] }, null, 2)
        );

        const wrong = await rejected(root);

        expect(wrong.message).toContain(indexFile);
        expect(wrong.message).toContain('version 99');

        fs.writeFileSync(indexFile, 'nope');

        const corrupt = await rejected(root);

        expect(corrupt.message).toContain(indexFile);
        expect(corrupt.message).toContain('knowledge index is not valid JSON');
    });

    it('throws naming the file that fails the engine article validator', async () => {
        const { root, article } = await seed('invalid');
        const file = articleFileOf(root, article.id);

        // `unknownField` is not part of `KnowledgeArticle`, and a duplicate paragraph id is the
        // other half of the same validator: both are data loss if they were accepted silently.
        fs.writeFileSync(
            file,
            JSON.stringify(
                { version: HARNESS_KNOWLEDGE_VERSION, article: { ...article, unknownField: 1 } },
                null,
                2
            )
        );

        const unknown = await rejected(root);

        expect(unknown.message).toContain(file);
        expect(unknown.message).toContain('unknown field "unknownField"');

        fs.writeFileSync(
            file,
            JSON.stringify(
                {
                    version: HARNESS_KNOWLEDGE_VERSION,
                    article: { ...article, content: [article.content[0], article.content[0]] }
                },
                null,
                2
            )
        );

        const duplicate = await rejected(root);

        expect(duplicate.message).toContain(file);
        // The wording is the ENGINE's, quoted through verbatim: the store runs `readKnowledgeStoreState`
        // rather than a second validator, so this asserts the reuse instead of a paraphrase.
        expect(duplicate.message).toContain('repeats the id');
    });

    it('refuses a file whose name and content disagree about the article id', async () => {
        const { root, article } = await seed('mismatch');
        const file = articleFileOf(root, article.id);
        const other = pinnedEngine(uuidList(2)).execute({ verb: 'create', title: 'Other' }).article;

        fs.writeFileSync(
            file,
            JSON.stringify({ version: HARNESS_KNOWLEDGE_VERSION, article: { ...article, id: other.id } }, null, 2)
        );

        const failure = await rejected(root);

        expect(failure.message).toContain(file);
        expect(failure.message).toContain(`named "${article.id}.json"`);
        expect(failure.message).toContain(`names article "${other.id}"`);
    });

    it('skips a file whose name is not a uuid AS A DIAGNOSTIC, and ignores the staging family silently', async () => {
        const { root, article } = await seed('skipped');
        const events: KnowledgeStoreReportEvent[] = [];

        fs.writeFileSync(path.join(knowledgeDirectoryOf(root), 'notes.json'), JSON.stringify({ hello: 1 }));
        fs.writeFileSync(path.join(knowledgeDirectoryOf(root), 'state.json.knowledge.7.tmp'), '{"version":1,');

        const store = await loadKnowledgeFileStore({ root, report: (event) => events.push(event) });

        expect(store.engine.snapshot().articles).toEqual([article]);

        const loaded = events[0] as { kind: string; articles: number; diagnostics: string[] };

        expect(loaded.kind).toBe('loaded');
        expect(loaded.articles).toBe(1);
        // Exactly one diagnostic: the `.json` that is not an article. A half-written staging
        // file was ignored WITHOUT noise (it is a crashed write of this store's own family, not a
        // stranger's file), which is why the array is checked for length before its content.
        expect(loaded.diagnostics).toHaveLength(1);
        expect(loaded.diagnostics[0]).toContain('Skipped "notes.json"');
        expect(loaded.diagnostics[0]).toContain('must be a uuid');

        // The stranger's file survives: nothing in this store garbage-collects files it did not write.
        expect(fs.existsSync(path.join(knowledgeDirectoryOf(root), 'notes.json'))).toBe(true);
        expect(fs.existsSync(path.join(knowledgeDirectoryOf(root), 'state.json.knowledge.7.tmp'))).toBe(true);

        await expect(store.dispose()).resolves.toBeUndefined();
    });

    it('reports index/file divergence and loads the FILE, which is the authoritative record', async () => {
        const { root, article } = await seed('divergence');
        const ghost = uuidList(8)[7];
        const events: KnowledgeStoreReportEvent[] = [];

        // Hand-edit the article's title (the file now says something the index does not) and
        // hand-add an index row for an article that has no file.
        fs.writeFileSync(
            articleFileOf(root, article.id),
            articleBytesOf({ ...article, title: 'Edited on disk by hand' })
        );
        fs.writeFileSync(
            knowledgeIndexFileOf(root),
            JSON.stringify(
                {
                    version: HARNESS_KNOWLEDGE_VERSION,
                    savedAt: EPOCH_ISO,
                    articles: [
                        { id: article.id, title: article.title, updatedAt: EPOCH_ISO, file: `${article.id}.json` },
                        { id: ghost, title: 'Ghost', updatedAt: EPOCH_ISO, file: `${ghost}.json` }
                    ]
                },
                null,
                2
            )
        );

        const store = await loadKnowledgeFileStore({ root, report: (event) => events.push(event) });

        // The FILE won: the engine holds the edited title, not the index's stale one.
        expect(store.engine.articles().map((summary) => summary.title)).toEqual(['Edited on disk by hand']);

        const loaded = events[0] as { diagnostics: string[] };

        expect(loaded.diagnostics).toHaveLength(2);
        expect(loaded.diagnostics).toEqual(
            expect.arrayContaining([
                expect.stringContaining(`disagree about its title (index "${article.title}", file "Edited on disk by hand")`),
                expect.stringContaining(`article "${ghost}" as "${ghost}.json"`)
            ])
        );
        expect(loaded.diagnostics.join('\n')).toContain('no such file is in the directory');

        // RETAINED: the same lines stay askable after the fact, so a host that never wired a
        // `report` sink can still ask "is this base consistent?" and get the list, not a shrug.
        expect(store.diagnostics()).toEqual(loaded.diagnostics);

        // A forced pass that healed the accelerator (it rewrote the rows from the files, so the
        // ghost row and the stale title are both gone) clears the set as one unit: every line in it
        // now describes a file that no longer misbehaves, and keeping it would be a lie by omission
        // in the other direction.
        const repaired = await store.commit({ force: true });

        expect(repaired.due).toEqual({ created: [], modified: [], deleted: [] });
        expect(store.diagnostics()).toEqual([]);

        const reloaded = await loadKnowledgeFileStore({ root });

        expect(reloaded.diagnostics()).toEqual([]);

        await expect(store.dispose()).resolves.toBeUndefined();
        await expect(reloaded.dispose()).resolves.toBeUndefined();
    });

    it('rebuilt the index when a crash left the files and no index (the ordered-commit window)', async () => {
        // Pinned so the rebuilt index's `savedAt` is the same literal as everything else in this
        // file: the stamp comes from `Date.now()` at pass time, and an unpinned clock would make
        // this a range check instead of an exact one.
        pinClock();

        const { root, article } = await seed('index-less');

        fs.rmSync(knowledgeIndexFileOf(root), { force: true });

        const events: KnowledgeStoreReportEvent[] = [];
        const store = await loadKnowledgeFileStore({ root, report: (event) => events.push(event) });

        expect(store.engine.snapshot().articles).toEqual([article]);
        expect((events[0] as { diagnostics: string[] }).diagnostics).toEqual([
            expect.stringContaining(`no ${HARNESS_KNOWLEDGE_INDEX_FILE}; the index is rebuilt from the files.`)
        ]);

        // A commit rebuilds the accelerator from the records.
        const report = await store.commit({ force: true });

        expect(report.written).toEqual([]);
        // The repair pass found NOTHING missing on the article side: the files were complete, and
        // only the accelerator was gone. `storeRev` came back as the highest article rev, which is
        // the bound the files alone can give (the index that carried the exact counter is the file
        // that crashed).
        expect(report.due).toEqual({ created: [], modified: [], deleted: [] });
        expect(readJson(knowledgeIndexFileOf(root))).toEqual({
            version: HARNESS_KNOWLEDGE_VERSION,
            savedAt: EPOCH_ISO,
            articles: [{ id: article.id, title: 'Seeded', updatedAt: EPOCH_ISO, file: `${article.id}.json` }],
            storeRev: 1
        });

        await expect(store.dispose()).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 10-11. The incremental gate, and the repair pass
// ---------------------------------------------------------------------------

describe('knowledge file store — the incremental commit', () => {
    it('skips a byte-identical article, and heals one that was edited out of band', async () => {
        pinClock();

        const root = tempRoot('digest');
        const store = await loadKnowledgeFileStore({ root, engine: pinnedEngine(uuidList()), intervalMs: 0 });
        const article = createArticle(store.engine, 'Heal me', 'Canonical bytes.');

        await store.flush();

        const file = articleFileOf(root, article.id);
        const pretty = fs.readFileSync(file, 'utf8');

        // Same content, different bytes: a hand-edit that re-spelled the file compactly. The
        // digest of THIS writer's payload is unchanged, so only the `{size, mtimeMs}` witness can
        // notice it — which is exactly why the witness exists (./persistence.ts:2598-2621).
        fs.writeFileSync(file, JSON.stringify({ version: HARNESS_KNOWLEDGE_VERSION, article }));

        expect(fs.statSync(file).size).not.toBe(Buffer.byteLength(pretty, 'utf8'));

        const idle = await store.commit();

        expect(idle).toEqual(idleReport);

        const repaired = await store.commit({ force: true });

        expect(repaired.written).toEqual([article.id]);
        expect(fs.readFileSync(file, 'utf8')).toBe(pretty);

        // Forced, and nothing actually changed: the digest gate still holds, so the article is
        // skipped and only the index is re-stamped.
        const second = await store.commit({ force: true });

        expect(second.written).toEqual([]);
        expect(second.skipped).toEqual([article.id]);

        await expect(store.dispose()).resolves.toBeUndefined();
    });

    it('erases a file the engine no longer holds when a reset replaces the store', async () => {
        pinClock();

        const root = tempRoot('reset');
        const store = await loadKnowledgeFileStore({ root, engine: pinnedEngine(uuidList()), intervalMs: 0 });
        const kept = createArticle(store.engine, 'Survivor');

        // Durable FIRST, so the directory exists before a hand file appears in it: with the default
        // window the create's own commit is fire-and-forget, and an unawaited write here would race
        // the `mkdir` the commit performs.
        await store.flush();

        // A file the store never wrote (a hand copy, or a crash leftover) is swept by the
        // whole-store resync a `reset` arms: the reset's notification says the engine DELIBERATELY
        // holds nothing, so this file is an orphan, not an adoption candidate.
        fs.writeFileSync(articleFileOf(root, uuidList(8)[6]), articleBytesOf(kept).replace(kept.id, uuidList(8)[6]));

        store.engine.reset();

        const report = await store.flush();

        expect(report.erased).toEqual([kept.id, uuidList(8)[6]].sort());
        expect(fs.readdirSync(store.directory)).toEqual([HARNESS_KNOWLEDGE_INDEX_FILE]);

        const reloaded = await loadKnowledgeFileStore({ root, intervalMs: 0 });

        expect(reloaded.engine.snapshot()).toEqual({ storeRev: 0, articles: [] });

        await expect(store.dispose()).resolves.toBeUndefined();
        await expect(reloaded.dispose()).resolves.toBeUndefined();
    });

    // THE REPAIR PASS, all three ways the two sides come apart, in one scenario: a file the engine
    // has never heard of (another process committed it, or a crash landed between the article write
    // and the index write), a file deleted by hand while the engine still holds the article, and a
    // removal the engine made that never reached the disk.
    it('adopts an out-of-band create, rewrites a hand-deleted file, erases a removal that never landed, and proves the base consistent', async () => {
        pinClock();

        const root = tempRoot('repair');
        const engine = pinnedEngine(uuidList());
        const events: KnowledgeStoreReportEvent[] = [];
        // A window too long to fire inside the test: the engine-side removal below stays
        // uncommitted, so the ONLY pass that can act on any of this is the forced one awaited here.
        const store = await loadKnowledgeFileStore({
            root,
            engine,
            intervalMs: 60_000,
            report: (event) => events.push(event)
        });

        const kept = createArticle(engine, 'Kept');
        const gone = createArticle(engine, 'Removed in the engine');
        const erased = createArticle(engine, 'File deleted by hand');

        await store.flush();

        // 1. A file the engine has no article for, written by someone else — in the store's own
        //    canonical bytes, so the adoption costs no write and the finding is the file itself.
        const stray = pinnedEngine(uuidList(8, 8)).execute({
            verb: 'create',
            title: 'Written elsewhere',
            tags: ['ops'],
            content: ['Written by another process.']
        }).article;

        fs.writeFileSync(articleFileOf(root, stray.id), articleBytesOf(stray));

        // 2. A file removed by hand, for an article the engine still holds.
        fs.rmSync(articleFileOf(root, erased.id));

        // 3. A removal the engine made and the gate has not committed: the file is still there.
        engine.execute({ verb: 'remove', id: gone.id });

        // Nothing has surveyed the directory since the load, so the store has nothing RETAINED yet;
        // the lines below are the pass's findings, and what survives them is what it could not heal.
        expect(store.diagnostics()).toEqual([]);

        const repaired = await store.commit({ force: true });

        // The symmetric difference over article ids, keyed off the ENGINE (the authority for intent),
        // each list sorted ascending: the stray file is `created` (the engine never chose to lose
        // it), the hand-deleted file is `modified` (the engine holds an article the files lost), and
        // the gated removal is `deleted` (the engine DID choose, and the disk never caught up).
        expect(repaired.due).toEqual({
            created: [stray.id],
            modified: [erased.id],
            deleted: [gone.id]
        });

        // Only the hand-deleted file is a payload write: the adopted file already holds the canonical
        // bytes, so the digest gate skips it (`due.created` reported the file, not a syscall).
        expect(repaired.written).toEqual([erased.id]);
        expect(repaired.erased).toEqual([gone.id]);
        expect(repaired.skipped).toEqual([kept.id, stray.id].sort());
        expect(repaired.failure).toBeUndefined();

        // Every finding is a line naming the FILE, in the order the pass walked them: the adoption
        // (which happens before anything is judged), then the rewrite, then the erase.
        const pass = commitPasses(events).at(-1);

        expect(pass?.diagnostics).toEqual([
            expect.stringContaining(
                `"${stray.id}.json" for an article the engine does not hold; it is read in and adopted rather than erased`
            ),
            expect.stringContaining(
                `The knowledge article "${erased.id}" has no file ("${erased.id}.json" is missing); the engine is authoritative`
            ),
            expect.stringContaining(`"${gone.id}.json" for an article the engine removed`)
        ]);

        // The adopted article is now IN the engine — the whole point: durable knowledge was not
        // overwritten by a guess about who wrote the file. The order is the engine's creation order,
        // with the adopted article last (../core/knowledge.ts:1330-1334).
        expect(engine.articles().map((summary) => summary.title)).toEqual([
            'Kept',
            'File deleted by hand',
            'Written elsewhere'
        ]);

        const snapshot = engine.snapshot();
        const durable = new Map(snapshot.articles.map((article) => [article.id, article]));

        expect(fs.readFileSync(articleFileOf(root, erased.id), 'utf8')).toBe(articleBytesOf(durable.get(erased.id)!));
        expect(fs.readFileSync(articleFileOf(root, stray.id), 'utf8')).toBe(articleBytesOf(durable.get(stray.id)!));

        // The directory now describes exactly what the engine holds — one file per article plus the
        // accelerator — and the retained view is EMPTY, because a forced pass that repaired
        // everything is the store's proof that its view and the files agree.
        expect(fs.readdirSync(store.directory).sort()).toEqual(
            [`${kept.id}.json`, `${erased.id}.json`, `${stray.id}.json`, HARNESS_KNOWLEDGE_INDEX_FILE].sort()
        );
        expect(store.diagnostics()).toEqual([]);

        // The on-disk state IS the engine: a store that never saw this one loads the same snapshot,
        // article for article and watermark for watermark, with nothing left to report.
        const reloaded = await loadKnowledgeFileStore({ root });

        expect(reloaded.engine.snapshot()).toEqual(snapshot);
        expect(reloaded.readIndex()).toEqual(store.readIndex());
        expect(reloaded.diagnostics()).toEqual([]);

        await expect(store.dispose()).resolves.toBeUndefined();
        await expect(reloaded.dispose()).resolves.toBeUndefined();
    });

    // The other half of the adoption rule: a file this store CANNOT read is not a file it may
    // delete. Deleting it would turn a reportable problem into data loss, on the strength of the
    // same guess the adoption rule refuses to make.
    it('leaves a file it cannot read in place, reports it in `due.created`, and keeps the line', async () => {
        pinClock();

        const root = tempRoot('unadoptable');
        const store = await loadKnowledgeFileStore({ root, engine: pinnedEngine(uuidList()), intervalMs: 0 });
        const kept = createArticle(store.engine, 'Legitimate');

        await store.flush();

        const stray = uuidList(8)[6];
        const file = articleFileOf(root, stray);

        // A name the grammar accepts, content it does not: this pass cannot adopt it.
        fs.writeFileSync(
            file,
            JSON.stringify(
                { version: HARNESS_KNOWLEDGE_VERSION, article: { id: stray, title: 'Hand written', unknownField: 1 } },
                null,
                2
            )
        );

        const report = await store.commit({ force: true });

        // Reported as the out-of-band create it is, and NOT erased: `skipped` says the pass touched
        // nothing, `erased` is empty, and the failure is the message an operator acts on.
        expect(report.due).toEqual({ created: [stray], modified: [], deleted: [] });
        expect(report.erased).toEqual([]);
        expect(report.skipped).toEqual([kept.id, stray].sort());
        expect(report.failure).toContain(file);
        expect(fs.existsSync(file)).toBe(true);
        expect(articleIds(store.engine)).toEqual([kept.id]);

        // RETAINED, because nothing healed: the line names the file until a pass can read it.
        expect(store.diagnostics()).toEqual([expect.stringContaining('could not be adopted')]);

        // And the base is not quietly smaller on the next start: a reload is LOUD about the same
        // file, naming the same path (`load` never skips or deletes an article file it cannot read).
        const failure = await loadKnowledgeFileStore({ root }).then(
            () => undefined,
            (error: unknown) => error as Error
        );

        expect(failure?.name).toBe('HarnessPersistenceError');
        expect(failure?.message).toContain(file);
        expect(failure?.message).toContain('unknown field "unknownField"');

        await expect(store.dispose()).resolves.toBeUndefined();
    });

    it('keeps an injected engine article that has no file, and commits it as the first pass', async () => {
        pinClock();

        const root = tempRoot('seeded');
        const events: KnowledgeStoreReportEvent[] = [];
        const engine = pinnedEngine(uuidList());

        // The engine already holds the article when the store is built over an EMPTY root: the
        // only copy, so the files adopt it rather than the engine losing it.
        const article = createArticle(engine, 'Adopted');

        const store = await loadKnowledgeFileStore({
            root,
            engine,
            intervalMs: 0,
            report: (event) => events.push(event)
        });

        const loaded = events[0] as { articles: number; diagnostics: string[] };

        expect(loaded.articles).toBe(1);
        expect(loaded.diagnostics).toEqual([expect.stringContaining('kept and committed')]);

        await settle(() => fs.existsSync(articleFileOf(root, article.id)));

        expect(fs.readFileSync(articleFileOf(root, article.id), 'utf8')).toBe(articleBytesOf(article));

        const reloaded = await loadKnowledgeFileStore({ root, intervalMs: 0 });

        expect(reloaded.engine.snapshot().articles).toEqual([article]);

        await expect(store.dispose()).resolves.toBeUndefined();
        await expect(reloaded.dispose()).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 12. The traversal fence
// ---------------------------------------------------------------------------

describe('knowledge file store — the id is a path segment', () => {
    it('refuses every id that is not a uuid before joining it, and canonicalizes a case-folded uuid', () => {
        const root = tempRoot('fence');
        const id = uuidList(4)[0];

        expect(knowledgeArticleFileOf(root, id)).toBe(path.join(knowledgeDirectoryOf(root), `${id}.json`));

        // The engine canonicalizes ids to lowercase, so the path spelling must too — otherwise
        // one article is two files on a case-sensitive filesystem.
        expect(knowledgeArticleFileOf(root, id.toUpperCase())).toBe(knowledgeArticleFileOf(root, id));
        expect(knowledgeArticleFileOf(root, `  ${id}  `)).toBe(knowledgeArticleFileOf(root, id));

        for (const hostile of ['../../evil', 'a/b', '..', '', 'notes', 'notes.json', 'constructor', `${id}.json`]) {
            const thrown = (() => {
                try {
                    knowledgeArticleFileOf(root, hostile);

                    return undefined;
                } catch (error) {
                    return error as Error;
                }
            })();

            expect(thrown, `expected "${hostile}" to be refused`).toBeInstanceOf(Error);
            expect(thrown?.name).toBe('HarnessPersistenceError');
            expect(thrown?.message).toContain('must be a uuid');
            expect(thrown?.message).toContain('cannot be stored as a file');
        }
    });
});

// ---------------------------------------------------------------------------
// 13. Teardown
// ---------------------------------------------------------------------------

describe('knowledge file store — dispose', () => {
    it('flushes what is pending, clears the trailing timer, and stops tracking mutations', async () => {
        pinClock();

        const root = tempRoot('dispose');
        const events: KnowledgeStoreReportEvent[] = [];
        const engine = pinnedEngine(uuidList());
        const store = await loadKnowledgeFileStore({
            root,
            engine,
            intervalMs: 60_000,
            report: (event) => events.push(event)
        });

        const durable = createArticle(store.engine, 'Durable before shutdown');

        await store.flush();

        const armed = watchTimers();

        const deferred = createArticle(store.engine, 'Deferred at shutdown');

        expect(armed.map((timer) => timer.unrefed)).toEqual([true]);
        expect(fs.existsSync(articleFileOf(root, deferred.id))).toBe(false);

        // `dispose()` IS the barrier: the deferred article reaches the disk, once.
        const report = await store.dispose();

        expect(report?.written).toEqual([deferred.id]);
        expect(fs.existsSync(articleFileOf(root, deferred.id))).toBe(true);

        // The timer is gone, not pending: nothing else was armed while the store closed.
        expect(armed.map((timer) => timer.delay)).toEqual([60_000]);

        // Unsubscribed: a later mutation is neither tracked nor written, and it cannot
        // resurrect the timer.
        const eventsBefore = commitEvents(events).length;
        const after = createArticle(engine, 'After shutdown');

        expect(commitEvents(events)).toHaveLength(eventsBefore);
        expect(armed).toHaveLength(1);
        expect(fs.existsSync(articleFileOf(root, after.id))).toBe(false);

        // T15/F4: an explicit commit after teardown is REFUSED, not answered with a zero-work
        // success. The engine underneath is still live (the article above reached it), so a report
        // of `written: []` reads as "nothing owed, everything durable" to a caller that has just
        // lost an article — the refusal names the directory and the only remedy there is.
        const refusal = await store.commit().then(
            () => undefined,
            (error: unknown) => error as Error
        );

        expect(refusal).toBeInstanceOf(Error);
        expect(refusal?.name).toBe('HarnessPersistenceError');
        expect(refusal?.message).toContain(store.directory);
        expect(refusal?.message).toContain('is disposed');
        expect(refusal?.message).toContain('loadKnowledgeFileStore');

        // REFUSED means NOT ATTEMPTED: no pass ran, so no `commit` event landed, and the timer the
        // store armed before teardown is still the only one this scenario ever saw.
        expect(commitEvents(events)).toHaveLength(eventsBefore);
        expect(armed).toHaveLength(1);

        // `flush()` — the other durability verb — takes the same refusal, and a SECOND `dispose()`
        // stays idempotent: closing an already-closed store is not a durability request, so it
        // answers `undefined` instead of throwing.
        await expect(store.flush()).rejects.toThrow(/is disposed/);
        expect(commitEvents(events)).toHaveLength(eventsBefore);

        await expect(store.dispose()).resolves.toBeUndefined();
        expect(armed).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// 14. The staging family carries the pid (T15/F3)
// ---------------------------------------------------------------------------

describe('knowledge file store — the staging name carries the pid', () => {
    it('stages as `state.json.knowledge.<pid>.<n>.tmp`, which is what keeps a second PROCESS off the same stage', async () => {
        pinClock();

        const root = tempRoot('staging');

        // `commitHarnessFile` is the ONLY writer, and it opens its stage through `fs.openSync`
        // (./persistence.ts:2200). Spying it — call-through, not a fake, so the write stays real —
        // captures the exact name each store chose, which is the whole property here. The suffix
        // comes from a PER-STORE sequence starting at 0, so an owner token WITHOUT the pid put two
        // processes at the same `state.json.knowledge.0.tmp`; the stage is opened `'w'` (not `'wx'`)
        // and the failure path `rmSync`s it (:2222), so a shared name can publish the other writer's
        // payload or delete a live stage and fail the rename. The pid is the same disambiguator the
        // coordinator/IO-worker pair uses (`<pid>.io<threadId>`, ./persistence.ts:2124-2135).
        const opened = vi.spyOn(fs, 'openSync');

        const first = await loadKnowledgeFileStore({ root, engine: pinnedEngine(uuidList(8)), intervalMs: 0 });
        const second = await loadKnowledgeFileStore({ root, engine: pinnedEngine(uuidList(8, 16)), intervalMs: 0 });

        const mine = createArticle(first.engine, 'Writer one');
        const theirs = createArticle(second.engine, 'Writer two');

        // The loads above opened nothing (a load creates no file); count only the writes below.
        opened.mockClear();

        await first.flush();
        await second.flush();

        const stages = opened.mock.calls.map((call) => String(call[0])).filter((name) => name.endsWith('.tmp'));

        // Two stages per pass — the article file, then the index — spelled exactly as
        // `commitHarnessFile` builds it: prefix, owner, sequence, `.tmp`. The name a bare
        // `'knowledge'` owner would have produced is ABSENT, and that is the fix: this file can pin
        // the shape (one process, so one pid), and the cross-process claim follows from the pid being
        // IN the name. Inside THIS process the two stores above do share a stage name, safely,
        // because `commitHarnessFile` is synchronous end to end — that difference is exactly what the
        // token encodes, and the next assertion is the other half of it.
        expect(stages).toEqual([
            path.join(first.directory, `${HARNESS_DATABASE_FILE}.knowledge.${process.pid}.0.tmp`),
            path.join(first.directory, `${HARNESS_DATABASE_FILE}.knowledge.${process.pid}.1.tmp`),
            path.join(second.directory, `${HARNESS_DATABASE_FILE}.knowledge.${process.pid}.0.tmp`),
            path.join(second.directory, `${HARNESS_DATABASE_FILE}.knowledge.${process.pid}.1.tmp`)
        ]);
        expect(stages).not.toContain(path.join(first.directory, `${HARNESS_DATABASE_FILE}.knowledge.0.tmp`));

        // Nothing is left behind: every stage became its canonical file, and the directory holds
        // only the two articles and the accelerator.
        expect(fs.readdirSync(first.directory).sort()).toEqual([
            `${mine.id}.json`,
            `${theirs.id}.json`,
            HARNESS_KNOWLEDGE_INDEX_FILE
        ]);

        // An explicit `owner` is still honoured verbatim: the pid is the DEFAULT, not a wrapper the
        // store adds to a caller's token (`HarnessDatabaseWriteOptions.owner`, :2124-2135).
        const custom = await loadKnowledgeFileStore({
            root,
            engine: pinnedEngine(uuidList(8, 32)),
            intervalMs: 0,
            owner: 'ops'
        });

        createArticle(custom.engine, 'Writer three');
        opened.mockClear();

        await custom.flush();

        expect(
            opened.mock.calls.map((call) => String(call[0])).filter((name) => name.endsWith('.tmp'))
        ).toEqual([
            path.join(custom.directory, `${HARNESS_DATABASE_FILE}.ops.0.tmp`),
            path.join(custom.directory, `${HARNESS_DATABASE_FILE}.ops.1.tmp`)
        ]);

        await expect(first.dispose()).resolves.toBeUndefined();
        await expect(second.dispose()).resolves.toBeUndefined();
        await expect(custom.dispose()).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 15. The single-writer boundary (T15/F2)
// ---------------------------------------------------------------------------
//
// The module declares "no cross-PROCESS locking — one server process per database root"
// (./knowledge-file-store.ts, NON-GOALS) and the session store makes the same assumption
// (./persistence.ts:74-76). Two live stores over one root are what two such processes look like
// from inside this one, and the honest consequence is that an edit is LOST WITH NO SIGNAL. These
// tests do NOT ask for a lock, a journal or a `storeRev` re-read (all out of scope): they pin the
// posture, so a future change in it fails a test instead of regressing in silence.

describe('knowledge file store — two live stores over one root', () => {
    it("loses one writer's edit with no refusal, no failure and no diagnostic, even though both hold a valid token", async () => {
        pinClock();

        const root = tempRoot('two-writers');
        const firstEvents: KnowledgeStoreReportEvent[] = [];
        const secondEvents: KnowledgeStoreReportEvent[] = [];

        // One article with TWO paragraphs, durable, written by a store that then CLOSES — so both
        // writers below LOAD the same starting point instead of sharing an engine.
        const seededStore = await loadKnowledgeFileStore({ root, engine: pinnedEngine(uuidList(8)), intervalMs: 0 });
        const article = seededStore.engine.execute({
            verb: 'create',
            title: 'Runbook',
            content: ['Front door: rack 3.', 'Back door: rack 7.']
        }).article;

        await seededStore.flush();
        await expect(seededStore.dispose()).resolves.toBeUndefined();

        const first = await loadKnowledgeFileStore({
            root,
            engine: pinnedEngine(uuidList(8, 16)),
            intervalMs: 0,
            report: (event) => firstEvents.push(event)
        });
        const second = await loadKnowledgeFileStore({
            root,
            engine: pinnedEngine(uuidList(8, 32)),
            intervalMs: 0,
            report: (event) => secondEvents.push(event)
        });

        // Both engines hold the SAME article, so the SAME `expects` token is valid for both writers.
        // That is the whole boundary: the token is article-grain and per-engine, and an engine can
        // only ever compare it against its own copy.
        expect(first.engine.snapshot().articles).toEqual([article]);
        expect(second.engine.snapshot().articles).toEqual([article]);

        const expects = [{ id: article.id, rev: article.rev }];
        const [front, back] = article.content;

        const left = first.engine.execute({
            verb: 'modify',
            id: article.id,
            expects,
            setParagraphs: [{ id: front.id, text: 'Front door: re-keyed.' }]
        });
        const right = second.engine.execute({
            verb: 'modify',
            id: article.id,
            expects,
            setParagraphs: [{ id: back.id, text: 'Back door: welded shut.' }]
        });

        // NEITHER write was refused: a rejection would THROW (the engine has no rejection value), so
        // reaching here with both change lists is the proof. Each edit landed in its own engine.
        expect(left.changedIds).toEqual([front.id]);
        expect(right.changedIds).toEqual([back.id]);

        await first.flush();
        await second.flush();

        // Both stores report SUCCESS, with the article among the bytes they wrote. The loser is not
        // refused at the file layer either: its gate sees foreign bytes (digest and witness both
        // moved) and rewrites them, which is the mechanism that overwrites the winner.
        expect(commitPasses(firstEvents).map((event) => event.report.written)).toEqual([[article.id]]);
        expect(commitPasses(secondEvents).map((event) => event.report.written)).toEqual([[article.id]]);
        expect(commitPasses(firstEvents).map((event) => event.report.failure)).toEqual([undefined]);
        expect(commitPasses(secondEvents).map((event) => event.report.failure)).toEqual([undefined]);

        // ONE text survives: the file is the LATER commit's payload, byte for byte, and the earlier
        // writer's paragraph is gone from disk.
        const file = articleFileOf(root, article.id);

        expect(fs.readFileSync(file, 'utf8')).toBe(articleBytesOf(second.engine.snapshot().articles[0]));
        expect((readJson(file) as { article: KnowledgeArticle }).article.content.map((p) => p.text)).toEqual([
            'Front door: rack 3.',
            'Back door: welded shut.'
        ]);

        // AND NOTHING SAYS SO. `diagnostics()` is the store's memory of divergences it saw and has
        // not repaired, and from each side nothing diverged — a plain commit records no finding, and
        // each store's own view is exactly what it wrote. The loser keeps believing its text, too.
        expect(first.diagnostics()).toEqual([]);
        expect(second.diagnostics()).toEqual([]);
        expect(first.engine.snapshot().articles[0].content.map((p) => p.text)).toEqual([
            'Front door: re-keyed.',
            'Back door: rack 7.'
        ]);

        // The loss is DURABLE, not a stale in-memory view: the next load reads the winner back, and
        // it says nothing either — files and accelerator agree, because the loser never re-wrote.
        const reloaded = await loadKnowledgeFileStore({ root, engine: pinnedEngine(uuidList(8, 48)), intervalMs: 0 });

        expect(reloaded.engine.snapshot().articles).toEqual(second.engine.snapshot().articles);
        expect(reloaded.diagnostics()).toEqual([]);

        await expect(first.dispose()).resolves.toBeUndefined();
        await expect(second.dispose()).resolves.toBeUndefined();
        await expect(reloaded.dispose()).resolves.toBeUndefined();
    });

    it('tolerates a lost `index.json` row across two writers, because the files are the record and the next load self-heals it', async () => {
        pinClock();

        const root = tempRoot('two-writers-create');
        const first = await loadKnowledgeFileStore({ root, engine: pinnedEngine(uuidList(8, 16)), intervalMs: 0 });
        const second = await loadKnowledgeFileStore({ root, engine: pinnedEngine(uuidList(8, 32)), intervalMs: 0 });

        const mine = createArticle(first.engine, 'Written by one');
        const theirs = createArticle(second.engine, 'Written by two');

        await first.flush();
        await second.flush();

        // ONE FILE PER ARTICLE is what makes two writers survivable at all: each article is its own
        // document, so BOTH payloads are on disk whatever the accelerator says.
        expect(fs.readdirSync(knowledgeDirectoryOf(root)).sort()).toEqual([
            `${mine.id}.json`,
            `${theirs.id}.json`,
            HARNESS_KNOWLEDGE_INDEX_FILE
        ]);

        // The only casualty is the accelerator: `index.json` is one document rewritten WHOLE by the
        // later commit, and that engine never saw the other writer's article.
        expect(readJson(knowledgeIndexFileOf(root))).toEqual({
            version: HARNESS_KNOWLEDGE_VERSION,
            savedAt: EPOCH_ISO,
            articles: [{ id: theirs.id, title: 'Written by two', updatedAt: EPOCH_ISO, file: `${theirs.id}.json` }],
            storeRev: 1
        });

        // The row loss is TOLERATED, and the proof is that nothing is lost: the next load reads BOTH
        // articles back off the FILES and reports the accelerator disagreeing, rather than serving
        // half a base.
        const reloaded = await loadKnowledgeFileStore({ root, engine: pinnedEngine(uuidList(8, 48)), intervalMs: 0 });

        expect(reloaded.engine.snapshot().articles.map((article) => article.title)).toEqual([
            'Written by one',
            'Written by two'
        ]);
        expect(reloaded.diagnostics()).toEqual([expect.stringContaining('The knowledge index does not list article')]);

        // A LIVE writer self-heals the same way on a forced pass: a file it never held is ADOPTED
        // (a peer's durable knowledge, not an orphan to erase), so a lost row costs one survey and
        // never an article.
        const survey = await first.commit({ force: true });

        expect(survey.due).toEqual({ created: [theirs.id], modified: [], deleted: [] });
        expect(survey.skipped).toEqual([mine.id, theirs.id]);
        expect(articleIds(first.engine)).toEqual([mine.id, theirs.id]);

        await expect(first.dispose()).resolves.toBeUndefined();
        await expect(second.dispose()).resolves.toBeUndefined();
        await expect(reloaded.dispose()).resolves.toBeUndefined();
    });
});

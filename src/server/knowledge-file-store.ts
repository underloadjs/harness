// knowledge-file-store — the DURABLE half of the cross-session knowledge store (T5).
//
// WHAT THIS MODULE IS
// -------------------
// ../core/knowledge.ts is the engine: purely in-memory, synchronous, and it never learns
// where its bytes are kept. This module is the SUBSCRIBER that puts those bytes on disk and
// keeps them there — the same division `records` uses for its observation plane
// (../core/records.ts:2479-2525), and for the same reason: the engine stays the single
// source of truth, and a dead transport fails an observer, never a write.
//
// The point of the whole exercise is the LIFETIME. Sessions come and go (`sessions/<id>/`
// goes with the session — ./persistence.ts:225 + ./journal.ts); knowledge outlives them. That
// is why this store hangs off the harness ROOT and not off any session directory: a killed or
// deleted session leaves the knowledge tree exactly where it was, and the next session reads
// the same articles back. ./knowledge-file-store.test.ts proves it by loading a SECOND store
// over the same root and getting the articles byte-for-byte.
//
// THE LAYOUT
// ----------
//   <databaseRoot>/harness/knowledge/index.json   read accelerator: version, savedAt, and one
//                                                 row per article { id, title, updatedAt, file }
//   <databaseRoot>/harness/knowledge/<id>.json    ONE article: { version, article }
//
// `<databaseRoot>` is the DATABASE root the deployment already uses for sessions, so the
// store writes at `<root>/harness/knowledge/` — beside `harness/sessions/`,
// `harness/index.json` and `harness/agents.json`, and outside every session folder.
// `KnowledgeStoreOptions.root` takes the DATABASE root and appends `harness/knowledge/`
// itself, so no caller can spell the namespace two ways. A missing directory is an EMPTY
// store, not a failure: `loadKnowledgeFileStore` does NOT create it (a load must stay
// side-effect-free, so a read-only mount can still serve reads), and the first commit does,
// because `commitHarnessFile` `mkdir -p`s its own directory. `ENOENT` is quiet; anything
// else is loud.
//
// ONE JSON FILE PER ARTICLE, AND WHY
// ----------------------------------
// The commit unit is the article. The session store learned the lesson the hard way
// (./persistence.ts:2253-2261: a 110 MB `state.json` was a measured 800 ms checkpoint because
// one appended token re-stringified every conversation). With one file per article, editing a
// paragraph costs one small file, the failure radius of a bad byte is one article, and
// `index.json` stays a few kilobytes however big the base gets.
//
// The engine caps the store at KNOWLEDGE_MAX_ARTICLES (100) × KNOWLEDGE_MAX_PARAGRAPHS (64) ×
// KNOWLEDGE_MAX_TEXT (4000), so the whole base is bounded and per-article bytes stay small
// enough to pretty-print (`null, 2`). That is a deliberate deviation from the session shards'
// compact bytes (./persistence.ts:2091-2100 optimised a 110 MB document); this file optimises
// for a human or an agent grepping a bounded article, exactly like the `agents.json` overlay
// at ./persistence.ts:3329-3346, which is the closest precedent for "a durable JSON document
// at the harness root" and is `null, 2` too. Every byte assertion here compares PARSED content
// plus the raw bytes two writers produced, so spacing is a style choice and never a contract a
// reader depends on.
//
// AUTHORITY: THE ARTICLE FILES, NOT THE INDEX
// -------------------------------------------
// `<id>.json` is the record. `index.json` is written in the same pass and is a READ
// ACCELERATOR: it lets a cold start (or an operator panel) list the base without opening a
// hundred files, and it is the only file carrying a wall-clock `savedAt`.
//
// On load the store reads the article files, makes them the engine's state, then VERIFIES the
// index against them — it never trusts either side. Each disagreement is a diagnostic naming
// the article (an entry with no file, a file with no entry, an entry whose `title`/`updatedAt`
// or `file` disagrees with the article it names); none of them abort startup, because the
// files answer the question either way. The blast radius of this `index.json` is therefore
// SMALLER than the harness header's on purpose (./persistence.ts:135-137 aborts startup on an
// unreadable `harness/index.json` because that file IS the document): an unreadable,
// unparseable or wrong-version knowledge `index.json` still aborts — it is the file an
// operator opens first, and a silent clean slate would let a corrupt index masquerade as "no
// knowledge" — but a structurally valid index that merely DISAGREES with the files is reported.
//
// ATOMIC COMMIT, INHERITED NOT DUPLICATED
// ---------------------------------------
// Every byte this store writes goes through ./persistence.ts `writeHarnessDatabaseFile` →
// `commitHarnessFile`: `mkdir -p` → `openSync` → `writeFileSync` → `fsyncSync` → `closeSync` →
// same-directory `renameSync`, staging file `<dir>/state.json.<owner>.<n>.tmp`, staging removed
// on failure, and the canonical file NEVER unlinked first — a crash leaves either the old
// complete file or the new complete one (./persistence.ts:2137-2229). Durability boundary,
// stated exactly as that file states it: the payload bytes are fsynced and the directory ENTRY
// is replaced; the directory entry is not fsynced, so after a hard power loss the rename itself
// may not have survived.
//
// `owner` defaults to `'knowledge.<pid>'` — the `owner: 'agents'` precedent (./persistence.ts:3344)
// plus the pid that literal had replaced. Two halves, two different jobs: the `knowledge`
// prefix makes this store's staging names disjoint from the session store's and the agent
// overlay's (structural, not luck), and the pid makes them disjoint from ANOTHER PROCESS writing
// the same directory, which a constant cannot do. `commitHarnessFile` derives
// `<prefix>.<owner ?? process.pid>.<n>.tmp` (./persistence.ts:2172-2175) and the suffix comes from
// a PER-STORE sequence that starts at 0, so two stores both spelling the bare constant would both
// stage `state.json.knowledge.0.tmp` — the stage is opened `'w'`, not `'wx'` (`:2200`), and the
// failure path `rmSync`s it (`:2222`), so a shared name can publish the other writer's payload or
// delete a live stage and fail the rename. Same reasoning as the coordinator/IO-worker pair, which
// keeps names apart while sharing one pid via `<pid>.io<threadId>` (`HarnessDatabaseWriteOptions`,
// ./persistence.ts:2124-2135). One `createHarnessStagingSequence()` per store is still enough
// WITHIN a store, because the suffix is monotonic and the commit pass is synchronous. Staging
// leftovers end in `.tmp`, so the loader ignores them: a crashed write strands a file, never an
// article (the same no-garbage-collection stance as ./persistence.ts:148-150).
//
// A COMMIT IS ORDERED, and the order is the torn-set story (./persistence.ts:78-89 puts
// deletions last and the header last of all):
//   1. article files (new and changed),
//   2. erasures of files the store no longer holds,
//   3. `index.json` LAST.
// A crash between 1/2 and 3 leaves files in the NEW state beside a STALE index — a reported
// divergence, and a lossless one, since the files answer the load. The reverse order would
// leave a fresh index naming files that are not there yet: an article the accelerator promises
// and the record does not have.
//
// A COMMIT IS ALSO INCREMENTAL, and self-healing: each file is content-addressed (sha256 of the
// payload) against the last bytes THIS writer committed, and is skipped only when the bytes
// match AND the file still carries the `{size, mtimeMs}` witness recorded at the time. Those
// three helpers are reused verbatim (`harnessShardDigest`, `harnessShardCommitStampOf`,
// `harnessShardStampOf`, ./persistence.ts:2580-2631), including the reason the witness exists:
// a digest alone cannot notice an out-of-band edit, because it hashes THIS writer's own bytes.
// `load()` primes both digests and witnesses from the bytes it read, so the first commit after
// a restart costs only what actually changed — a byte-identical article stays untouched
// (`written: []`), and a hand-edited one is rewritten.
//
// FAILURE POLICY
// --------------
// LOAD is loud: an unreadable directory, an unknown/unsupported `version`, malformed JSON, an
// envelope with an unknown key, an article that fails the engine's own strict reader, a file
// whose name and content disagree on the id, or two files claiming one id all throw
// `HarnessPersistenceError` naming the FILE (./persistence.ts:583-594). Nothing is reset,
// skipped or deleted: a silently ignored article would let a corrupt file masquerade as a
// smaller knowledge base. The one deliberate exception is a name that is not a uuid at all —
// the engine could never address that article, so it is skipped and reported (a stranger's
// `notes.json` must not take the whole base down).
//
// WRITE is reported, never thrown: `KnowledgeCommitReport.failure` carries the message (which
// names the file, because `commitHarnessFile` builds it that way), the failing article stays
// DIRTY so the next pass retries it, and the in-memory change is never lost. A pass that failed
// does NOT rewrite the index (`indexDirty` stays set), so the accelerator never claims an
// article whose file is not durable. A store on a full disk keeps serving reads from the engine
// and keeps trying to commit.
//
// THE COMMITTER (the ./sessions.ts checkpoint discipline, at knowledge grain)
// ---------------------------------------------------------------------------
// A mutation arrives as an `engine.onStoreChange` notification, SYNCHRONOUSLY inside the engine
// call. It marks the affected articles dirty (and, for `remove`, marks their files for erasure),
// then decides WHEN the bytes move:
//
//   - outside the interval, or the FIRST commit of this store's life (the cold-start anchor,
//     ./sessions.ts:6232-6241): commit now, so a mutation right after startup is durable fast
//     instead of being swallowed by the window;
//   - inside the interval: arm ONE trailing `setTimeout` for the rest of the window
//     (./sessions.ts:6272-6295). One timer per store, armed only if none is pending, so a burst
//     of fifty edits shares one flush; `timer.unref()` because a pending commit is work the
//     process may legitimately die with; the deferred write runs UNCONDITIONALLY — re-testing
//     the gate inside the timer with a pinned clock would drop the change forever, the exact bug
//     recorded at ./sessions.ts:6265-6268.
//
// The DURABILITY TRADE-OFF, stated as ./sessions.ts:495-521 states it: a crash loses at most one
// interval of knowledge EDITS — never an article that was never written at all, because the
// anchor commits the first one immediately — and it regresses to an earlier COHERENT commit
// point (a whole article file, never half of one). Anything that must be durable before a
// response calls `commit()`/`flush()` and awaits it; the engine stays synchronous, so a model's
// tool call never blocks on a syscall unless its caller asked for durability.
//
// THE DEFAULT WINDOW IS ZERO (`HARNESS_KNOWLEDGE_INTERVAL_MS = 0`), and that is a decision about
// the UNIT OF WORK, not a hedge: the knowledge tool's cadence is one article edit per tool call —
// an already-atomic, settled change, not a token stream — so batching buys nothing and the
// property the tool wants is "durable before the next call". It stands on that reasoning ALONE:
// the sibling it used to be compared to, `VIEW_CHECKPOINT_INTERVAL_MS`, is 2 s (`./sessions.ts:523`)
// — a window sized for per-token conversation churn, and copying it here would only widen the
// crash hole around one settled article for nothing. At zero the gate is not dead code either: it
// coalesces the notifications of one synchronous burst (a paragraph move, then a title rewrite =
// TWO notifications) into ONE pass, and the trailing timer is what makes a non-zero window work.
//
// `flush()` is the awaitable durability barrier (`drainIo`, ./sessions.ts:2160-2192, is the
// precedent): it clears the trailing timer, runs a pass, and keeps running passes until nothing
// is pending, so concurrent callers join one in-flight write and a barrier against a quiet store
// answers `written: []` with ZERO syscalls. `dispose()` = flush + clear timer + unsubscribe, and
// a commit after `dispose()` never re-arms the timer. A disposed store also REFUSES the work it can
// no longer do: `commit()`/`flush()` reject with a `HarnessPersistenceError` naming the directory
// and the remedy (load a store again), instead of answering a zero-work `written: []` to a caller
// whose article is not durable. The engine underneath stays live — a host may share it — only THIS
// store's durability is over, and nothing a late caller does can arm a timer again.
//
// A BARRIER ANSWERS WITH THE PASS THAT DID THE WORK. Joining an in-flight pass is still free, but
// the report handed back is the best one the call saw — a forced pass beats a plain one (only the
// forced one looked at the directory), a pass that moved bytes beats an idle one, a failure beats
// silence, and a tie goes to the later measurement. A trailing idle pass therefore cannot hide the
// write a caller is waiting to hear about, and a forced request that arrives while a PLAIN pass is
// running waits for it and then runs its own pass instead of being answered with a shallow report.
//
// THE REPAIR PASS, AND WHAT IT RETAINS
// ------------------------------------
// `commit({ force: true })` re-examines BOTH sides instead of trusting the notification delta:
// every article the engine holds (a hand-edited file heals) and every file in the directory. It
// answers `report.due`, the symmetric difference keyed off the ENGINE as authority for intent —
// `created` (a file with no article), `modified` (an article whose file is missing or whose bytes
// disagree), `deleted` (an article the engine REMOVED whose file is still there), each sorted
// ascending so a caller can assert on it.
//
// A `created` finding is ADOPTED, not erased. A file the engine has no article for may be
// knowledge another process committed, or the residue of a crash between the article write and the
// index write; deleting it would destroy durable knowledge on the strength of a guess. So it is
// re-read through the same strict reader `load` uses and merged into the engine (creation order,
// watermark never moving backwards), and the post-restore resync writes its index row. The one
// case that still erases is an id the engine reported as REMOVED: there the loss was DELIBERATE,
// which is also what keeps `reset` meaning "a clean start" (../core/knowledge.ts:2492-2500) rather
// than "re-read whatever is lying around". A file that cannot be read or validated is reported and
// LEFT IN PLACE — this pass cannot repair it and must not destroy it.
//
// Those findings are EMITTED and KEPT. `diagnostics()` is the store's own memory of every
// divergence it has seen and not yet repaired — the load findings plus every standing forced-pass
// finding — and a forced pass that ends with no failure clears the set as one unit, which is the
// store's proof that its view and the files agree. A host that never wired a `report` sink can
// still ask, after the fact, whether the base is consistent.
//
// TESTABILITY: the gate reads the clock through `Date.now()` at call time, and the timer through
// bare `setTimeout`/`clearTimeout`, so the `pinTaskClock` policy of ./persistence.test.ts:335-342
// applies unchanged — freeze `Date.now` to make the interval arithmetic and the `savedAt` stamps
// exact, and leave `setTimeout` real so the deferred write still happens.
//
// NON-GOALS
// ---------
// No HTTP surface, no UI, no cross-PROCESS locking (one server process per database root,
// ./persistence.ts:74-76 — the session store makes the same single-writer assumption), no
// migration ladder (a version mismatch throws), no garbage collection of `.tmp` leftovers, and no
// writes outside `<root>/harness/knowledge/`: `harness/index.json`, `harness/sessions/` and
// `harness/agents.json` belong to ./persistence.ts and are never touched here.
//
// WHAT THAT SINGLE-WRITER ASSUMPTION COSTS, stated because it is a deployment constraint and not a
// detail: TWO live stores over one database root each commit THEIR OWN engine, and the later commit
// replaces the earlier one's article file. Both callers get a successful `KnowledgeCommitReport`
// and both `diagnostics()` stay EMPTY, because from each store's own side nothing failed — the
// loser's edit is simply gone, with no signal. The article-level `expects` token cannot catch it:
// each editor holds a token that is valid against its OWN engine, which is the only copy the engine
// can compare against. `commit({ force: true })` ADOPTS a file this engine never held (:1255-1344),
// so an out-of-band CREATE converges on the next pass, and a stale article is
// rewritten because the digest+witness gate sees the foreign bytes — but nothing merges two versions
// of ONE article, and `index.json`'s `storeRev` is exactly the number a cross-writer CAS could have
// used and is not: no commit re-reads it. One server process per database root is therefore the
// rule; `./knowledge-file-store.test.ts` pins the consequence, so a future change of posture fails
// a test instead of regressing in silence.
//
// Cross-references:
//   - ../core/knowledge.ts            — the engine: `createKnowledgeEngine`,
//                                       `readKnowledgeStoreState` (the strict reader this file
//                                       reuses per article), `KNOWLEDGE_UUID_PATTERN` (the id
//                                       grammar AND the traversal fence), `onStoreChange`
//   - ./persistence.ts                — `writeHarnessDatabaseFile`/`commitHarnessFile` (the
//                                       commit), `harnessShardDigest` +
//                                       `harnessShardCommitStampOf` + `harnessShardStampOf`
//                                       (the incremental gate), `normalizeHarnessDatabaseRoot`
//                                       (root validation), `HarnessPersistenceError`,
//                                       `agents.json` (the closest root-level-JSON precedent)
//   - ./sessions.ts                   — `VIEW_CHECKPOINT_INTERVAL_MS`, `checkpoint`,
//                                       `scheduleCheckpoint`, `clearCheckpointTimer`, `drainIo`
//   - ./persistence-coalescing.test.ts— the "at most one write per interval" counting idiom
//   - ../types/index.ts               — `KnowledgeArticle`, `KnowledgeEngine`,
//                                       `KnowledgeStoreNotification`
//   - ./knowledge-file-store.test.ts  — every rule above, pinned against real files

import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeArticle, KnowledgeEngine, KnowledgeStoreNotification } from '../engine/types';
import { KNOWLEDGE_UUID_PATTERN, createKnowledgeEngine, readKnowledgeStoreState } from '../engine/core/knowledge';
import {
    readSnapshotArray,
    readSnapshotInteger,
    readSnapshotKeys,
    readSnapshotRecord,
    readSnapshotString
} from '../engine/core/snapshot-validation';
import {
    HarnessPersistenceError,
    createHarnessStagingSequence,
    harnessShardCommitStampOf,
    harnessShardDigest,
    harnessShardStampOf,
    normalizeHarnessDatabaseRoot,
    resolveHarnessDatabaseRoot,
    writeHarnessDatabaseFile
} from './persistence';
import type { HarnessShardCommitStamp } from './persistence';

// ---------------------------------------------------------------------------
// Names, version, and the tuning constants
// ---------------------------------------------------------------------------

// The one directory this store owns, below `<databaseRoot>/harness`. It doubles as the
// namespace an operator greps: `<root>/harness/knowledge/`.
export const HARNESS_KNOWLEDGE_DIRECTORY = 'knowledge';

// The read accelerator. NOTE for readers who know the harness layout: this is NOT
// `harness/index.json` (the session document header, ./persistence.ts:222) — it is a different
// file one level deeper, and this store never reads or writes that header.
export const HARNESS_KNOWLEDGE_INDEX_FILE = 'index.json';

// The envelope version, written by this file and gated on read. Bumped ONLY when the on-disk
// shape becomes incompatible, and a mismatch throws naming the file — the
// `HARNESS_DATABASE_VERSION`/`HARNESS_JOURNAL_VERSION` idiom (./persistence.ts:194-202): no
// migration guessing, because guessing which of two shapes a file holds is how a silent clean
// slate starts.
export const HARNESS_KNOWLEDGE_VERSION = 1;

// Default commit window: ZERO, because the knowledge tool's cadence is one article edit per
// tool call — a settled, already-atomic unit — so durability has no reason to wait for a batch,
// and "the mutation is durable before the next call" is the property the tool wants. That reasoning
// is its OWN, not inherited: `VIEW_CHECKPOINT_INTERVAL_MS` is 2 s (./sessions.ts:523, trade-off at
// ./sessions.ts:495-521), sized for per-token conversation churn, while one settled article per
// call leaves nothing to batch. The GATE below still matters at zero: it coalesces one synchronous
// burst (a `knowledge` call that moves a paragraph then rewrites a title is two notifications) into
// one pass, and the trailing timer is what makes a NON-zero `intervalMs` work at all.
export const HARNESS_KNOWLEDGE_INTERVAL_MS = 0;

// The staging owner token used when the caller does not name one. TWO halves, each doing a
// different job (the header note at :80-94 is the full argument): the `knowledge` prefix makes this
// writer's `.tmp` names disjoint from every OTHER subsystem's in the same directory — the
// `owner: 'agents'` precedent (./persistence.ts:3344) — and `process.pid` makes them disjoint from
// another PROCESS writing the same directory, which a bare constant cannot be: `commitHarnessFile`
// derives `<prefix>.<owner ?? process.pid>.<n>.tmp` (:2172-2175), each store's sequence starts at 0,
// the stage is opened `'w'` not `'wx'` (:2200), and the failure path `rmSync`s it (:2222). Two
// stores spelling the same constant would therefore stage the same name —
// `state.json.knowledge.0.tmp` — and could publish each other's payload or delete a live stage. The
// pid is the same disambiguator the coordinator/IO-worker pair uses while sharing one pid
// (`<pid>.io<threadId>`, `HarnessDatabaseWriteOptions`, ./persistence.ts:2124-2135).
const knowledgeStagingOwnerOf = (): string => `knowledge.${process.pid}`;

// `flush()` runs passes until nothing is pending. The cap is defensive, not policy: every pass
// clears the work it handled, and a failing pass reports `failure`, which stops the loop on its
// own. Eight is far more than the number of passes one barrier can legitimately need.
const FLUSH_MAX_PASSES = 8;

// The harness namespace this store nests under. `HARNESS_DATABASE_DIRECTORY` says 'harness'
// (./persistence.ts:207); the literal is spelled here on purpose so this store does not inherit
// a future relocation of the SESSION tree, and ./knowledge-file-store.test.ts pins the path.
const HARNESS_NAMESPACE = 'harness';

// ---------------------------------------------------------------------------
// The on-disk shapes
// ---------------------------------------------------------------------------

// One article file: the article, plus the format version that gates how it is read. The
// ENVELOPE carries the version (not the index) because the article file is the record: a reader
// that opens one file directly, with no index, still knows what it is holding.
export interface KnowledgeArticleFile {
    version: number;
    article: KnowledgeArticle;
}

// One `index.json` row. `file` is the article's file NAME (`<id>.json`), joined with the
// directory this index sits in — a basename, not an absolute path, so a copied tree stays
// readable (`KnowledgeStore.directory` is the join base; `knowledgeArticleFileOf` is the
// absolute spelling).
export interface KnowledgeDirectoryIndexEntry {
    id: string;
    title: string;
    updatedAt: string;
    file: string;
}

// The whole accelerator.
//
// `storeRev` is the ONE field that is not derivable from the article files: the engine counts
// MUTATIONS (`storeRev += 1`, ../core/knowledge.ts:2012, 2324, 2372), while an article's `rev`
// counts edits to THAT article, so an article created and then removed leaves a storeRev the
// files cannot show. `KnowledgeEngine.restore()` takes that number explicitly
// (../core/knowledge.ts:2487), so a durable layer that dropped it could not answer a reload with
// the pre-restart snapshot — hence it lives here, on the accelerator, which is the only file with
// store-level scope. It stays OPTIONAL: an index written without it (a crash window, or a hand
// built file) loads, and the loader falls back to the highest article rev.
export interface KnowledgeDirectoryIndex {
    version: number;
    savedAt: string;
    articles: KnowledgeDirectoryIndexEntry[];
    storeRev?: number;
}

// What one commit pass did. The three id lists are the audit trail:
//   - `written` — article ids whose file this pass actually wrote (an article already on disk
//                 with identical bytes goes to `skipped`, so `written` means "a syscall");
//   - `erased`  — article ids whose file this pass actually deleted;
//   - `skipped` — ids the pass examined and left alone (bytes matched the last committed digest
//                 AND witness, or an erase was asked for a file that was not there);
//   - `bytes`   — UTF-8 bytes handed to the write path this pass (article files AND the index);
//   - `at`      — ISO-8601 stamp of the pass, which is also the `savedAt` of the index it wrote;
//   - `failure` — set when a write or an erase failed: the message names the file, the article
//                 stays dirty for the next pass, and the index was left alone. ABSENT rather
//                 than `undefined`-valued (../core/knowledge.ts:55-57 — the stored JSON and any
//                 deep-equal against this report measure the real shape).
//
// `index.json` is deliberately not one of the id lists: it is not an article, and a caller
// asserting on `written` wants article ids. Whether the index moved is observable from the file
// itself (its `savedAt`) or from the store's `report` diagnostics.
//
// `due` is the repair pass's own answer, and it is PRESENT ONLY ON A FORCED PASS: a non-forced
// pass works from the engine notifications it was told about, so it has no opinion about files it
// never saw. A forced pass compares the engine and the directory directly, and reports what that
// comparison found — the three lists are a SYMMETRIC difference over article ids, each sorted
// ascending (a stable order for a caller asserting on it, and for the diagnostic lines built from
// it), and each one keyed off the ENGINE, which is authoritative for intent:
//   - `created`  — a file the engine has no article for (adoption candidate: a file another
//                  process dropped, or the residue of a crash between write and index);
//   - `modified` — an article whose file is missing or whose bytes are not the bytes the engine
//                  implies (the rewrite set);
//   - `deleted`  — an article the engine REMOVED whose file is still on disk (the erase set —
//                  only deliberate removals land here, which is what keeps `created` out of it).
// Every entry is also a diagnostic line naming the file, and `due` is the machine-readable half
// of the same finding `diagnostics()` retains.
export interface KnowledgeCommitReport {
    written: string[];
    erased: string[];
    skipped: string[];
    bytes: number;
    at: string;
    /** Only on a forced pass; see the note above. Sorted ascending. */
    due?: {
        created: string[];
        modified: string[];
        deleted: string[];
    };
    failure?: string;
}

// Diagnostics the store emits: `loaded` answers the cold start (what was restored, plus every
// skipped file and index divergence found on the way in); `commit` answers one pass that had
// work; `failure` answers one failing file, so a caller that only wants problems filters on
// `kind`. Every `diagnostics` array is present and possibly EMPTY, so an assertion against it
// is exact rather than conditional.
export type KnowledgeStoreReportEvent =
    | {
          kind: 'loaded';
          directory: string;
          articles: number;
          storeRev: number;
          diagnostics: string[];
      }
    | {
          kind: 'commit';
          directory: string;
          report: KnowledgeCommitReport;
          diagnostics: string[];
      }
    | {
          kind: 'failure';
          directory: string;
          file: string;
          message: string;
          /** The article the failure is about, when the file maps to one. */
          id?: string;
      };

// How a caller builds one store.
export interface KnowledgeStoreOptions {
    /**
     * The deployment's DATABASE root — the same value ./runtime.ts hands `SessionStore` and
     * where `harness/sessions/` lives. This store appends `harness/knowledge/` itself. A blank
     * value is a loud `HarnessPersistenceError` (./persistence.ts:612-628), never a silently
     * in-memory knowledge base.
     */
    root: string;
    /** Commit window; default `HARNESS_KNOWLEDGE_INTERVAL_MS` (0 — commit on every change).
     *  A positive value batches notifications into one pass per window, trailing-edge. */
    intervalMs?: number;
    /** Staging owner token; mirrors `HarnessDatabaseWriteOptions.owner` (./persistence.ts:2124).
     *  Default `knowledge.<pid>` (`knowledgeStagingOwnerOf`): the prefix separates this subsystem's
     *  staging family from every other one in the directory, and the pid separates this PROCESS from
     *  every other one writing the same root. Two stores in ONE process may share a staging NAME
     *  safely — `commitHarnessFile` is synchronous end to end, so no two stages are ever alive at
     *  once — which is exactly what a second PROCESS cannot promise (./persistence.ts:2200, :2222). */
    owner?: string;
    /**
     * Inject a pre-built engine (the test seam, and how a host that already holds an engine
     * adopts one). Omit it and the store builds its own `createKnowledgeEngine()`.
     *
     * Merge rule on load, because either side can legitimately hold articles: the FILES win per
     * article (they are the durable record); an article the engine holds with no file is KEPT
     * and marked dirty (it has never been committed, and dropping it would lose the only copy);
     * every such difference is a load diagnostic. A fresh engine is the normal case and simply
     * reads the files in.
     */
    engine?: KnowledgeEngine;
    /** Optional diagnostics sink: once per load, once per pass with work, once per failure. */
    report?: (event: KnowledgeStoreReportEvent) => void;
}

// The awaitable durability barrier as a type a host can hold (the `drainIo` role,
// ./sessions.ts:2172) — e.g. a shutdown hook that also flushes knowledge.
export type KnowledgeFlush = () => Promise<KnowledgeCommitReport>;

// The store: the durable half, plus the engine it keeps durable.
export interface KnowledgeStore {
    /** Absolute, resolved DATABASE root (what `knowledgeDirectoryOf` takes). */
    readonly root: string;
    /** `<root>/harness/knowledge` — this store's own directory. */
    readonly directory: string;
    /**
     * The shared in-memory engine. Reads and writes go through it synchronously (`execute`,
     * `articles`, `search`, `read`); durability is this store's job.
     */
    readonly engine: KnowledgeEngine;
    /**
     * The index as this store last wrote it — i.e. what `index.json` says right now, detached
     * (a caller mutating the copy cannot reach the store). It therefore lags an uncommitted
     * mutation by at most one interval: `await commit()` first when a reader must see the edit,
     * or read the live article set from `engine.articles()`.
     */
    readIndex(): KnowledgeDirectoryIndex;
    /**
     * Commit what is due. Coalescing: concurrent callers join the in-flight pass, and EVERY
     * caller that asked for work gets the report of a pass that actually did some — a forced
     * request that finds a plain pass already running waits for it and then runs its own
     * (deeper) pass, rather than being handed back a shallow report. Idempotent: with nothing
     * pending it performs ZERO syscalls and answers `written: []`. `force: true` re-examines
     * every article AND every file in the directory (the repair pass: a hand-edited file heals,
     * a file the engine deliberately removed is erased, a file the engine has no article for is
     * ADOPTED into the engine instead of deleted, and the index is restamped), still skipping
     * bytes that genuinely match, and answers `report.due`.
     *
     * The survey is a DEBT, not a private request: once a forced pass has been asked for, the NEXT
     * pass that arms examines the directory — which may be a pass another caller armed first. Nobody
     * can dodge a survey that is owed, and a caller waiting on a forced request always ends holding
     * a report that has `due` (the pass it joined, or the one the debt armed).
     *
     * After `dispose()` this REFUSES: a disposed store has no subscription, no timer and no
     * durability left, so a `HarnessPersistenceError` naming the directory (and the remedy — load a
     * store again) comes back instead of a zero-work `written: []` success. The engine it was built
     * on is untouched and may still be shared, so reads and in-memory writes keep working; what is
     * over is the promise that they reach the files.
     */
    commit(options?: { force?: boolean }): Promise<KnowledgeCommitReport>;
    /**
     * Awaitable durability barrier: clears the trailing timer, then commits until nothing is
     * pending. Await it before answering a caller whose answer must survive a crash. Answers the
     * last report that did work — a pass that found nothing pending never hides the one that
     * wrote something. Rejects with the same disposed-store refusal `commit()` throws; a host that
     * disposed its store has to load a new one, not keep flushing the dead handle.
     */
    flush: KnowledgeFlush;
    /**
     * The divergences this store has SEEN AND NOT YET REPAIRED: the load-time findings (a file
     * that is not an article, an index row that disagrees with the files) plus every forced-pass
     * finding that is still standing (a file the engine lacks, a file whose bytes disagree). The
     * lines are the same strings the `report` sink got, kept here so a host that never wired a
     * sink can still ask "is the base consistent?" after the fact — and cleared, as one set,
     * when a forced pass finishes clean, which is the proof the store's own view matches the
     * files. It never accumulates a finding it has already repaired.
     */
    diagnostics(): string[];
    /**
     * Flush, clear the trailing timer, and unsubscribe from the engine. Answers the final report,
     * or `undefined` when there was nothing to flush. Idempotent — a second `dispose()` answers
     * `undefined` and performs no syscall — and no timer is re-armed afterwards: a late notification
     * (another store sharing this engine) is ignored, and an explicit `commit()`/`flush()` is
     * REFUSED (`HarnessPersistenceError`) rather than pretending the base is still durable.
     */
    dispose(): Promise<KnowledgeCommitReport | undefined>;
}

// ---------------------------------------------------------------------------
// Paths, and the traversal fence
// ---------------------------------------------------------------------------

// The id grammar is the ENGINE's (`KNOWLEDGE_UUID_PATTERN`, ../core/knowledge.ts:297), not a
// second regex — a second truth about what an id is would be a second thing that can drift. An
// id that fails it is refused BEFORE it is path-joined: this is the fence
// `HARNESS_SESSION_ID_PATTERN` exists for (./persistence.ts:236-249) and it is just as
// load-bearing here, because the id IS the file name and a hand-edited `../../x` would read,
// write and (on erase) DELETE a path outside `<root>/harness/knowledge/`.
const knowledgeArticleIdOf = (id: unknown): string => {
    // The engine canonicalizes ids to lowercase on the way in (../core/knowledge.ts:299-304), so
    // the file layer canonicalizes the same way. Without it an upper-cased uuid is ONE article
    // in the engine and TWO files on a case-sensitive filesystem.
    const canonical = typeof id === 'string' ? id.trim().toLowerCase() : '';

    if (!KNOWLEDGE_UUID_PATTERN.test(canonical)) {
        throw new HarnessPersistenceError(
            typeof id === 'string' ? id : String(id),
            `A knowledge article file name must be a uuid (${KNOWLEDGE_UUID_PATTERN}); "${
                typeof id === 'string' ? id : String(id)
            }" cannot be stored as a file.`
        );
    }

    return canonical;
};

// `<databaseRoot>/harness/knowledge`. `resolveHarnessDatabaseRoot` makes two spellings of one
// directory share one path, exactly like every other root in this package (./persistence.ts:608-610).
export const knowledgeDirectoryOf = (root: string): string =>
    path.join(resolveHarnessDatabaseRoot(root), HARNESS_NAMESPACE, HARNESS_KNOWLEDGE_DIRECTORY);

// `<databaseRoot>/harness/knowledge/index.json`.
export const knowledgeIndexFileOf = (root: string): string =>
    path.join(knowledgeDirectoryOf(root), HARNESS_KNOWLEDGE_INDEX_FILE);

// `<databaseRoot>/harness/knowledge/<id>.json`, traversal-fenced. Throws naming the ID, like
// `harnessSessionShardName` does (./persistence.ts:2363-2369), because at the call sites that
// matter the id is the only useful thing the message can name.
export const knowledgeArticleFileOf = (root: string, id: string): string =>
    path.join(knowledgeDirectoryOf(root), `${knowledgeArticleIdOf(id)}.json`);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// `HarnessPersistenceError` takes no `cause` parameter — `commitHarnessFile` assigns the property
// by hand (./persistence.ts:2177-2189), so this file follows the same shape: the path is in the
// MESSAGE, and the raw failure rides along as `cause` for a caller that wants it.
const persistenceFailure = (file: string, message: string, cause?: unknown): HarnessPersistenceError => {
    const failure = new HarnessPersistenceError(file, message);

    try {
        (failure as Error & { cause?: unknown }).cause = cause;
    } catch {
        // Frozen host: the message is the contract, the cause is a bonus.
    }

    return failure;
};

// The watermark FALLBACK: what a restored engine starts at when `index.json` does not carry one
// (a crash window that lost the index, or a hand-built one). The engine counts MUTATIONS
// (`storeRev += 1`), so the highest article rev is the best available lower bound — it is always
// at or above every CAS token a restored article can carry, which is the property the engine's
// watermark exists to keep (`../core/knowledge.ts:1343-1347`: a resumed engine that restarted the
// count would let the file layer skip a commit it believed it owed). The exact counter, when the
// index has it, is preferred; see `KnowledgeDirectoryIndex.storeRev`.
const storeRevOf = (articles: readonly KnowledgeArticle[]): number =>
    articles.reduce((highest, article) => (article.rev > highest ? article.rev : highest), 0);

// Which of two commit reports answers the CALLER better, highest first. The ranking depends on
// what the caller asked for, because "the report that actually did the work" means two different
// things:
//   +8 — a FORCED pass, and only for a caller that asked for one: a plain report cannot answer a
//        forced request (it never looked at the directory), so the survey is the only acceptable
//        answer. For a plain caller the same report is worth +1, and loses to bytes;
//   +5 — a pass that FAILED: the failure is the thing a caller acts on, and a later quiet pass must
//        not bury it;
//   +4 — a pass that moved bytes or erased a file ("the report that actually did the work");
//   0  — an idle pass (nothing to do).
// A tie goes to the LATER report: it measured the files most recently.
const rankReport = (report: KnowledgeCommitReport, forced: boolean): number =>
    (report.due === undefined ? 0 : forced ? 8 : 1) +
    (report.written.length + report.erased.length > 0 ? 4 : 0) +
    (report.failure === undefined ? 0 : 5);

const preferReport = (
    current: KnowledgeCommitReport | undefined,
    next: KnowledgeCommitReport,
    forced: boolean
): KnowledgeCommitReport =>
    current === undefined || rankReport(next, forced) >= rankReport(current, forced) ? next : current;

// ---------------------------------------------------------------------------
// Payloads: one article in, canonical bytes out
// ---------------------------------------------------------------------------

// The canonical bytes of one article file. Key order is fixed here and mirrors
// `KnowledgeArticleFile`, so a load -> commit cycle lands on the same bytes — which is what lets
// the incremental gate mean "byte-identical" rather than "semantically equal".
const knowledgeArticlePayloadOf = (article: KnowledgeArticle): string =>
    JSON.stringify({ version: HARNESS_KNOWLEDGE_VERSION, article }, null, 2);

// The index this store would write for `articles` right now. Entry order follows the engine's own
// article order, which is CREATION order (../core/knowledge.ts:1330-1334), so a caller paging the
// index before any ranking sees exactly the order `list` answers with. `storeRev` rides along
// because it is the one engine field with no article file to live in (see the interface note).
const knowledgeIndexOf = (
    articles: readonly KnowledgeArticle[],
    savedAt: string,
    storeRev: number
): KnowledgeDirectoryIndex => ({
    version: HARNESS_KNOWLEDGE_VERSION,
    savedAt,
    articles: articles.map((article) => ({
        id: article.id,
        title: article.title,
        updatedAt: article.updatedAt,
        file: `${article.id}.json`
    })),
    storeRev
});

const knowledgeIndexPayloadOf = (index: KnowledgeDirectoryIndex): string => JSON.stringify(index, null, 2);

// ---------------------------------------------------------------------------
// Strict readers (load side). Every throw names the file it came from.
// ---------------------------------------------------------------------------

// One article file, parsed and validated. The version gate runs BEFORE the content check: a
// future format's article may legitimately fail this build's reader, and "version 2, this build
// reads 1" is the actionable message while "unknown field id" is not.
//
// The content check reuses the ENGINE's own strict article reader by wrapping the article in a
// one-article store state and calling `readKnowledgeStoreState` (../core/knowledge.ts:1235). That
// IS the whole validation — id grammar, unknown keys, title/text/tag bounds, paragraph shape,
// cross-paragraph id uniqueness — with no second validator to drift. Refs are NOT resolved here:
// a dangling ref is legal stored state (../core/knowledge.ts:46-51), so files may be read in any
// order.
const readKnowledgeArticleFileText = (file: string, text: string, expectedId: string): KnowledgeArticle => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw persistenceFailure(file, `The knowledge article file is not valid JSON: ${messageOf(error)}`, error);
    }

    const label = 'the knowledge article file';
    const envelope = readSnapshotRecord(parsed, label);

    readSnapshotKeys(envelope, ['version', 'article'], label);

    const version = readSnapshotInteger(envelope.version, `${label}.version`, { min: 1, max: Number.MAX_SAFE_INTEGER });

    if (version !== HARNESS_KNOWLEDGE_VERSION) {
        throw persistenceFailure(
            file,
            `The knowledge article file is version ${version}; this build reads version ${HARNESS_KNOWLEDGE_VERSION} only, and it does not guess between formats.`
        );
    }

    let article: KnowledgeArticle;

    try {
        article = readKnowledgeStoreState({ storeRev: 0, articles: [envelope.article] }).articles[0];
    } catch (error) {
        throw persistenceFailure(file, `The knowledge article file is not a valid article: ${messageOf(error)}`, error);
    }

    // Name/content agreement. The file name IS the address; if the content claims a different id,
    // one of them moved, and guessing which would let two files describe one article.
    if (article.id !== expectedId) {
        throw persistenceFailure(
            file,
            `The knowledge article file is named "${expectedId}.json" but its content names article "${article.id}"; the file name IS the article id, so one of them moved.`
        );
    }

    return article;
};

// `index.json`, parsed and shape-validated. SHAPE failures are fatal (this is the file an operator
// opens first, and a silently empty index reads as "no knowledge"); the disagreement-with-the-files
// check is separate and only reports.
const readKnowledgeIndexText = (file: string, text: string): KnowledgeDirectoryIndex => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw persistenceFailure(file, `The knowledge index is not valid JSON: ${messageOf(error)}`, error);
    }

    const label = 'the knowledge index';
    const envelope = readSnapshotRecord(parsed, label);

    // `storeRev` is the only OPTIONAL key: an index written before this build's watermark field
    // (or hand-built for a test) still loads, and the loader falls back to `storeRevOf`.
    readSnapshotKeys(envelope, ['version', 'savedAt', 'articles', 'storeRev'], label, ['storeRev']);

    const version = readSnapshotInteger(envelope.version, `${label}.version`, { min: 1, max: Number.MAX_SAFE_INTEGER });

    if (version !== HARNESS_KNOWLEDGE_VERSION) {
        throw persistenceFailure(
            file,
            `The knowledge index is version ${version}; this build reads version ${HARNESS_KNOWLEDGE_VERSION} only, and it does not guess between formats.`
        );
    }

    const savedAt = readSnapshotString(envelope.savedAt, `${label}.savedAt`, { min: 1 });
    // The watermark, when the file carries one: a mutation counter, so 0 is a real value (a
    // store that has never committed anything) and anything else must be a non-negative integer.
    const storeRev =
        envelope.storeRev === undefined
            ? undefined
            : readSnapshotInteger(envelope.storeRev, `${label}.storeRev`, { min: 0, max: Number.MAX_SAFE_INTEGER });
    const rows = readSnapshotArray(envelope.articles, `${label}.articles`);
    const seen = new Set<string>();

    const articles = rows.map((entry, index) => {
        const rowLabel = `${label}.articles[${index}]`;
        const row = readSnapshotRecord(entry, rowLabel);

        readSnapshotKeys(row, ['id', 'title', 'updatedAt', 'file'], rowLabel);

        // Grammar-checked because `file` is joined onto this directory by every reader of the
        // index, and `id` doubles as that name.
        const id = knowledgeArticleIdOf(readSnapshotString(row.id, `${rowLabel}.id`, { min: 1 }));

        if (seen.has(id)) {
            throw persistenceFailure(file, `The knowledge index lists article "${id}" more than once.`);
        }

        seen.add(id);

        return {
            id,
            title: readSnapshotString(row.title, `${rowLabel}.title`, { min: 1 }),
            updatedAt: readSnapshotString(row.updatedAt, `${rowLabel}.updatedAt`, { min: 1 }),
            file: readSnapshotString(row.file, `${rowLabel}.file`, { min: 1 })
        };
    });

    // `storeRev` is ABSENT (not 0-valued) when the file did not name one, so the loader can tell
    // "no watermark on disk" from "the watermark on disk is 0" without a second signal. Key order
    // matches `knowledgeIndexOf`, so a parsed-then-restamped index is byte-stable.
    return {
        version: HARNESS_KNOWLEDGE_VERSION,
        savedAt,
        articles,
        ...(storeRev === undefined ? {} : { storeRev })
    };
};

// Is this directory entry the file of an article? Returns the canonical id, or `undefined` for
// `index.json`, a staging leftover, or a name whose stem is not a uuid.
//
// A `*.json` whose stem is not a uuid is not an article: it is a hand note, a copy, or a foreign
// tool's drop, and the engine could never address such an article. Skipping it (and saying so) is
// the right radius — aborting a whole knowledge base because somebody dropped `notes.json` next to
// the files is not.
const knowledgeFileIdOf = (file: string): string | undefined => {
    if (!file.endsWith('.json') || file === HARNESS_KNOWLEDGE_INDEX_FILE) return undefined;

    const stem = file.slice(0, -'.json'.length).trim().toLowerCase();

    return KNOWLEDGE_UUID_PATTERN.test(stem) ? stem : undefined;
};

// One file read off the directory: the article, the digest and witness of the EXACT bytes that
// produced it (so the first commit after a restart skips it), and the path.
type LoadedArticle = {
    id: string;
    file: string;
    article: KnowledgeArticle;
    digest: string;
    stamp: HarnessShardCommitStamp;
};

type KnowledgeDirectoryRead = {
    /** Directory absent (ENOENT): an empty store, and nothing may be assumed about commits. */
    missing: boolean;
    /** CREATION order (`createdAt`, then id) — the order the engine is restored in. */
    articles: LoadedArticle[];
    index: KnowledgeDirectoryIndex | undefined;
    indexDigest: string | undefined;
    indexStamp: HarnessShardCommitStamp | undefined;
    /** `*.json` names that are not article ids: skipped, reported, never fatal. */
    skipped: string[];
};

const readKnowledgeDirectory = (directory: string): KnowledgeDirectoryRead => {
    let names: string[];

    try {
        names = fs.readdirSync(directory);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;

        // ENOENT is the first-run case: no knowledge yet, nothing to fail. Anything else (EACCES,
        // EIO, ENOTDIR) is loud, naming the directory.
        if (code === 'ENOENT') {
            return {
                missing: true,
                articles: [],
                index: undefined,
                indexDigest: undefined,
                indexStamp: undefined,
                skipped: []
            };
        }

        throw persistenceFailure(directory, `Could not read the knowledge directory: ${messageOf(error)}`, error);
    }

    const articles: LoadedArticle[] = [];
    const byId = new Map<string, LoadedArticle>();
    const skipped: string[] = [];
    let index: KnowledgeDirectoryIndex | undefined;
    let indexDigest: string | undefined;
    let indexStamp: HarnessShardCommitStamp | undefined;

    // Sorted so both the duplicate-id collision and the load diagnostics are deterministic.
    for (const name of [...names].sort()) {
        const file = path.join(directory, name);

        if (name === HARNESS_KNOWLEDGE_INDEX_FILE) {
            let text: string;

            try {
                text = fs.readFileSync(file, 'utf8');
            } catch (error) {
                // The listing named it and it is gone: one entry vanished mid-read, the same shape
                // as a missing directory, so it is treated the same way.
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;

                throw persistenceFailure(file, `Could not read the knowledge index: ${messageOf(error)}`, error);
            }

            index = readKnowledgeIndexText(file, text);
            indexDigest = harnessShardDigest(text);
            // The FULL commit stamp (digest + `{size, mtimeMs}` witness), same as an article file:
            // `harnessShardCommitStampOf` re-stats and falls back to the payload length / mtime 0
            // when the stat fails, which can only ever cost one redundant write.
            indexStamp = harnessShardCommitStampOf(file, indexDigest, text);

            continue;
        }

        const id = knowledgeFileIdOf(name);

        // Non-`.json` names (including the whole `state.json.<owner>.<n>.tmp` staging family) are
        // ignored silently: they were never candidates. A `.json` whose stem is not a uuid is
        // skipped WITH a diagnostic.
        if (id === undefined) {
            if (name.endsWith('.json')) skipped.push(name);

            continue;
        }

        let text: string;

        try {
            text = fs.readFileSync(file, 'utf8');
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            // A directory named `<uuid>.json`, or a file that vanished mid-read: skip the unusable
            // entry rather than abort a knowledge base over one bad path.
            if (code === 'ENOENT' || code === 'EISDIR') {
                skipped.push(name);

                continue;
            }

            throw persistenceFailure(file, `Could not read the knowledge article file: ${messageOf(error)}`, error);
        }

        const article = readKnowledgeArticleFileText(file, text, id);
        const digest = harnessShardDigest(text);
        const loaded: LoadedArticle = {
            id,
            file,
            article,
            // The digest is of the bytes AS READ (not of a re-serialization) and the witness is
            // re-statted, so "unchanged" means "these exact bytes are still there" even for a file
            // this build did not write. `harnessShardCommitStampOf` supplies the payload-length /
            // mtime-0 fallback when the stat fails, which can only ever cost one redundant write.
            digest,
            stamp: harnessShardCommitStampOf(file, digest, text)
        };

        const previous = byId.get(id);

        if (previous !== undefined) {
            // Only reachable on a case-sensitive filesystem (`<UUID>.json` beside `<uuid>.json`).
            // Which one wins would be arbitrary, and arbitrary is exactly what must not decide a
            // knowledge base.
            throw persistenceFailure(
                file,
                `Two knowledge article files claim article "${id}" ("${path.basename(previous.file)}" and "${name}"); one of them must go.`
            );
        }

        byId.set(id, loaded);
        articles.push(loaded);
    }

    // CREATION order, so a restart pages the way a fresh engine does (the index rows and
    // `snapshot()` both follow this order).
    articles.sort((left, right) => {
        const created = left.article.createdAt.localeCompare(right.article.createdAt);

        return created !== 0 ? created : left.id.localeCompare(right.id);
    });

    return { missing: false, articles, index, indexDigest, indexStamp, skipped };
};

// Index-vs-files verification. The files already won; this reports the disagreement, because a
// divergence the operator can read is a different thing from a silently trusted accelerator.
const knowledgeIndexDiagnosticsOf = (
    index: KnowledgeDirectoryIndex | undefined,
    articles: readonly LoadedArticle[]
): string[] => {
    const diagnostics: string[] = [];
    const byId = new Map<string, LoadedArticle>(articles.map((loaded) => [loaded.id, loaded]));

    if (index === undefined) {
        // Normal, not corrupt: the ordered commit writes the index LAST, so a crash right after
        // the article files leaves precisely this state, and the next commit rebuilds it.
        if (articles.length > 0) {
            diagnostics.push(
                `The knowledge directory holds ${articles.length} article file(s) and no ${HARNESS_KNOWLEDGE_INDEX_FILE}; the index is rebuilt from the files.`
            );
        }

        return diagnostics;
    }

    const listed = new Set(index.articles.map((entry) => entry.id));

    for (const loaded of articles) {
        if (listed.has(loaded.id)) continue;

        diagnostics.push(
            `The knowledge index does not list article "${loaded.id}" ("${loaded.article.title}") that its file "${path.basename(loaded.file)}" carries; the file is authoritative.`
        );
    }

    for (const entry of index.articles) {
        const loaded = byId.get(entry.id);

        if (loaded === undefined) {
            diagnostics.push(
                `The knowledge index lists article "${entry.id}" as "${entry.file}", and no such file is in the directory; the index is an accelerator, so nothing was loaded for it.`
            );

            continue;
        }

        if (entry.file !== `${entry.id}.json`) {
            diagnostics.push(
                `The knowledge index names file "${entry.file}" for article "${entry.id}", whose file name is "${entry.id}.json"; the id IS the file name.`
            );
        }

        if (entry.title !== loaded.article.title) {
            diagnostics.push(
                `The knowledge index and article "${entry.id}" disagree about its title (index "${entry.title}", file "${loaded.article.title}"); the file is authoritative.`
            );
        }

        if (entry.updatedAt !== loaded.article.updatedAt) {
            diagnostics.push(
                `The knowledge index and article "${entry.id}" disagree about its updatedAt (index "${entry.updatedAt}", file "${loaded.article.updatedAt}"); the file is authoritative.`
            );
        }
    }

    return diagnostics;
};

// Every article id with a file in `directory`, traversal-fenced by construction (only a name whose
// stem is a uuid is returned). A failed listing is a diagnostic, never fatal: the caller still
// holds the engine, and the next pass retries.
const onDiskArticleIds = (directory: string, diagnostics: string[]): string[] => {
    try {
        const ids: string[] = [];

        for (const name of fs.readdirSync(directory)) {
            const id = knowledgeFileIdOf(name);

            if (id !== undefined) ids.push(id);
        }

        return ids;
    } catch (error) {
        diagnostics.push(
            `The knowledge directory could not be listed for the orphan sweep: ${messageOf(error)}; the next commit retries.`
        );

        return [];
    }
};

/**
 * Read the durable knowledge base and return the store that keeps it that way.
 *
 * Rejects (loudly, naming the offending file) on an unreadable directory, an unusable article
 * file, or an index whose envelope cannot be understood. Resolves for a missing directory — that
 * is an empty store, and the first commit creates the tree.
 */
export const loadKnowledgeFileStore = async (options: KnowledgeStoreOptions): Promise<KnowledgeStore> => {
    // A blank root is a refusal, not an in-memory store (./persistence.ts:612-628): a bad
    // deployment `variables.root` must not silently serve a knowledge base nobody can see.
    const root = normalizeHarnessDatabaseRoot(options.root) ?? '';
    const directory = knowledgeDirectoryOf(root);
    const engine = options.engine ?? createKnowledgeEngine();
    const intervalMs = options.intervalMs ?? HARNESS_KNOWLEDGE_INTERVAL_MS;
    const owner = options.owner ?? knowledgeStagingOwnerOf();
    const emit = options.report;

    // ONE staging sequence per writer (./persistence.ts:2667-2673, same reasoning): the staging
    // name also carries the owner token, and the commit pass is synchronous, so two writes by
    // this store cannot pick the same name and a stale staging file is never reused.
    const writeOptions = { owner, sequence: createHarnessStagingSequence() };

    // ---- pending-work state, declared before the load resolution that fills it --------------
    // Articles whose file may differ from the engine, and articles whose file must go. BOTH are
    // re-resolved against the CURRENT snapshot inside the pass, so a create-then-remove (or a
    // remove-then-restore) inside one window lands on the right answer whatever order the
    // notifications arrived in.
    const dirty = new Set<string>();
    const removed = new Set<string>();

    // `loading` suppresses the notification `restore` fires below: loading is not a mutation, and
    // an article that just came off a file must not be marked dirty for the next commit.
    let loading = false;

    const read = readKnowledgeDirectory(directory);
    const diagnostics: string[] = read.skipped.map(
        (name) =>
            `Skipped "${name}" in ${directory}: a knowledge article file name must be a uuid, so this file is not one.`
    );

    // ---- resolve the files (authoritative) against whatever the engine already holds --------
    const fileArticles = read.articles.map((loaded) => loaded.article);
    const fileIds = new Set(read.articles.map((loaded) => loaded.id));
    // The snapshot, not just the articles: an injected engine that was written to before the store
    // was built carries a watermark the files cannot know about, and the load must not drop it.
    const seededState = engine.snapshot();
    const seeded = seededState.articles;
    const engineOnly = seeded.filter((article) => !fileIds.has(article.id));

    if (engineOnly.length > 0) {
        diagnostics.push(
            `The engine already held ${engineOnly.length} article(s) with no file (${engineOnly
                .map((article) => article.id)
                .join(', ')}); they are kept and committed, and the file wins for any article both sides hold.`
        );
    }

    if (read.missing) {
        // Nothing durable yet: whatever the engine holds IS the store, and it becomes the first
        // commit. A fresh engine contributes nothing here, so the cold start stays a no-op.
        for (const article of seeded) dirty.add(article.id);
    } else if (fileArticles.length > 0 || seeded.length > 0) {
        loading = true;

        try {
            // The watermark NEVER MOVES BACKWARDS through a load: it is the higher of what the
            // files carry (`index.json`'s counter, or the best bound the article files alone can
            // give) and what the engine already counted. The first term covers a process restart
            // against durable work; the second covers an injected engine that was written to BEFORE
            // the store was built, whose counter the files cannot know about.
            engine.restore({
                storeRev: Math.max(read.index?.storeRev ?? storeRevOf(fileArticles), seededState.storeRev),
                articles: [...fileArticles, ...engineOnly]
            });
        } finally {
            loading = false;
        }

        // Articles the files do not carry still owe their first write.
        for (const article of engineOnly) dirty.add(article.id);
    }

    diagnostics.push(...knowledgeIndexDiagnosticsOf(read.index, read.articles));

    // ---- the retained divergence view ---------------------------------------------------------
    // The store's memory of every divergence it has seen and NOT yet repaired, seeded with the
    // load findings (the skipped names, the engine-held articles, the index that disagrees with the
    // files) because the load is where most of them are first seen. A forced pass that ends with no
    // failure drops the set as one unit: that pass compared both sides and healed what it found, so
    // anything still in the list would be a line about a file that no longer misbehaves.
    const divergence: string[] = [...diagnostics];

    // ---- the rest of this store's state ------------------------------------------------------
    // Last bytes this writer committed, per canonical file. Primed from the bytes `load` read, so
    // a restart costs only what changed (the `shardDigests` map at ./persistence.ts:2676-2687).
    const stamps = new Map<string, HarnessShardCommitStamp>();

    for (const loaded of read.articles) stamps.set(loaded.file, { ...loaded.stamp, digest: loaded.digest });

    if (read.index !== undefined && read.indexDigest !== undefined && read.indexStamp !== undefined) {
        stamps.set(knowledgeIndexFileOf(root), { ...read.indexStamp, digest: read.indexDigest });
    }

    // The index this store last wrote: the file's content when there was one, else the index the
    // engine's current articles imply (watermark included, so an implied index is the same shape a
    // written one has). Restamped by every pass that runs.
    let index: KnowledgeDirectoryIndex =
        read.index ??
        (() => {
            const loaded = engine.snapshot();

            return knowledgeIndexOf(loaded.articles, new Date(Date.now()).toISOString(), loaded.storeRev);
        })();

    let indexDirty = false;
    let resync = false;
    let pendingForce = false;
    let committedAt = 0;
    let firstCommitPending = true;
    let inFlight: Promise<KnowledgeCommitReport> | undefined;
    let flushing: Promise<KnowledgeCommitReport> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let subscribed = true;

    /**
     * The skip gate's second half: the payload digest alone cannot notice an out-of-band edit
     * (it hashes THIS writer's own bytes), so the file's `{size, mtimeMs}` witness has to match
     * too. A failed stat means "no witness" and therefore CHANGED — the only safe direction
     * (./persistence.ts:2598-2621).
     */
    const witnessMatches = (stamp: HarnessShardCommitStamp, file: string): boolean => {
        const witness = harnessShardStampOf(file);

        return witness !== undefined && witness.size === stamp.size && witness.mtimeMs === stamp.mtimeMs;
    };

    const hasPendingWork = (): boolean =>
        dirty.size > 0 || removed.size > 0 || resync || indexDirty || pendingForce || inFlight !== undefined;

    /**
     * One commit pass, synchronous END TO END — `commitHarnessFile` is sync — which is what makes
     * "two in-flight commits can never interleave writes to the same file" structural rather than
     * a lock: nothing runs between the two `renameSync` calls, and `inFlight` keeps concurrent
     * `commit()` callers in one pass. The article set is snapshotted ONCE here, so every file this
     * pass writes describes one moment.
     */
    const runCommitPass = (force: boolean): KnowledgeCommitReport => {
        // Read through the global so `vi.spyOn(Date, 'now')` (the `pinTaskClock` policy,
        // ./persistence.test.ts:335-342) makes the pass stamp — and therefore the index `savedAt`
        // — exact.
        const startedAt = Date.now();
        const at = new Date(startedAt).toISOString();
        const written: string[] = [];
        const erased: string[] = [];
        const skipped: string[] = [];
        const erases: { id: string; file: string }[] = [];
        const passDiagnostics: string[] = [];
        let bytes = 0;
        let failure: string | undefined;

        const noteFailure = (file: string, error: unknown, id?: string): void => {
            const message = messageOf(error);

            // The report names the FIRST failure (the raw string a caller acts on); every failure
            // still gets its own event, so none is hidden.
            if (failure === undefined) failure = message;

            emit?.({ kind: 'failure', directory, file, message, ...(id === undefined ? {} : { id }) });
        };

        // The three `due` lists (forced passes only). They are filled as the pass goes, from the
        // same observations the write decisions come from, so the report cannot disagree with the
        // syscalls that were made.
        const created: string[] = [];
        const modified: string[] = [];
        const deleted: string[] = [];

        // Disk-only files this pass could NOT read. They are reported like an adopted file (the
        // finding is the same), but they must not be erased: an unreadable file is a file this
        // store does not understand, and destroying it on the way past would turn a reportable
        // problem into data loss.
        const unadoptable = new Set<string>();

        let state = engine.snapshot();
        let byId = new Map<string, KnowledgeArticle>(state.articles.map((article) => [article.id, article]));

        // A `reset`/`restore` replaced the whole store, so the delta the notifications carried is
        // not the whole story: re-examine every article AND every file in the directory (a file the
        // new state does not name is an orphan and must be erased).
        const surveysDirectory = force || resync;

        // Every article id with a file, read ONCE per pass. Captured BEFORE adoption, because the
        // `deleted` list is defined against what was on disk when the pass started: an adopted file
        // must never read as deleted in the same report.
        const diskIds = surveysDirectory ? onDiskArticleIds(directory, passDiagnostics).sort() : [];

        // ---- A FORCED PASS ADOPTS BEFORE IT JUDGES ANYTHING ---------------------------------
        // A file the engine has no article for is not automatically garbage: it may be knowledge
        // another process committed, or the residue of a crash between the article write and the
        // index write. Deleting it would destroy durable knowledge on the strength of a guess, so
        // the file is read back through the same strict reader `load` uses and given to the engine.
        // The engine stays authoritative for INTENT: an id the engine reports as REMOVED (the
        // notification's `removedArticles`, which a `reset` fills the same way) is deliberately
        // gone, and its file is erased instead — which is also what keeps `reset` meaning "a clean
        // start" (../core/knowledge.ts:2492-2500) rather than "re-read whatever is lying around".
        // A `reset`/`restore` resync that is not forced skips adoption for the same reason: the
        // removal was explicit, not observed.
        if (force) {
            pendingForce = false;

            const live = state;
            const adopted: KnowledgeArticle[] = [];

            for (const id of diskIds) {
                if (byId.has(id) || removed.has(id)) continue;

                const file = knowledgeArticleFileOf(root, id);

                try {
                    const text = fs.readFileSync(file, 'utf8');
                    const article = readKnowledgeArticleFileText(file, text, id);

                    // Prime the digest/witness from the bytes JUST READ, so an adoption costs no
                    // write when the file already holds the canonical bytes (it is reported in
                    // `due.created` either way — the finding is the file's existence, not the
                    // syscall). A file whose bytes are NOT canonical still goes through the write
                    // gate below and is rewritten.
                    stamps.set(file, harnessShardCommitStampOf(file, harnessShardDigest(text), text));

                    adopted.push(article);
                    created.push(id);
                    passDiagnostics.push(
                        `The knowledge directory holds "${path.basename(file)}" for an article the engine does not hold; it is read in and adopted rather than erased, because a file is durable knowledge and the engine never chose to lose it.`
                    );
                } catch (error) {
                    // Unreadable or invalid: this pass cannot repair it and must not destroy it. The
                    // id is still the out-of-band-create finding (`created`), the line names the
                    // file, the pass reports a failure — and `unadoptable` keeps the erase step below
                    // from deleting the one file this store could not read.
                    unadoptable.add(id);
                    created.push(id);
                    passDiagnostics.push(
                        `The knowledge file "${path.basename(file)}" holds an article the engine does not hold and could not be adopted: ${messageOf(error)}; the file is left in place.`
                    );
                    noteFailure(file, error, id);
                }
            }

            if (adopted.length > 0) {
                // The merge keeps CREATION ORDER (existing articles first, then the adopted ones in
                // directory order) — the order `snapshot()`, the index rows and `list` all follow
                // (../core/knowledge.ts:1330-1334). The watermark takes the higher of the two, so a
                // restore can never move the engine's counter backwards.
                const merged = [...live.articles, ...adopted];

                loading = true;

                try {
                    engine.restore({
                        storeRev: Math.max(live.storeRev, storeRevOf(merged)),
                        articles: merged
                    });
                } catch (error) {
                    // `restore` validates into copies and leaves the live store untouched when it
                    // rejects (../core/knowledge.ts:2475-2478) — in practice two files claiming the
                    // same paragraph id, which the whole-store uniqueness rule forbids. Nothing was
                    // merged, so every file this step picked up is an UNADOPTABLE finding again:
                    // reported, kept, and specifically not erased by a pass that could not merge it.
                    for (const article of adopted) unadoptable.add(article.id);

                    noteFailure(directory, error);
                } finally {
                    loading = false;
                }

                state = engine.snapshot();
                byId = new Map<string, KnowledgeArticle>(state.articles.map((article) => [article.id, article]));

                // The adopted articles have no index row yet, and the watermark they imply may have
                // moved: both mean the accelerator is due for a rewrite at the end of this pass.
                indexDirty = true;

                for (const article of adopted) dirty.add(article.id);
            }
        }

        if (resync) {
            resync = false;

            for (const article of state.articles) dirty.add(article.id);

            for (const id of diskIds) {
                if (!byId.has(id)) removed.add(id);
            }
        }

        const candidates = new Set<string>([...dirty, ...removed]);

        if (force) {
            // The repair pass re-examines BOTH sides: every article the engine holds (a hand-edited
            // file heals) and every file in the directory (an orphan is erased or adopted).
            for (const id of byId.keys()) candidates.add(id);
            for (const id of diskIds) candidates.add(id);
        }

        // The index is rewritten when the store moved (an article is due) or when an earlier pass
        // failed to write it. Nothing due and a clean index is the IDLE case: zero syscalls, no
        // `commit` event, and `written: []` — which is what makes the interval gate countable.
        const writeIndex = force || indexDirty || candidates.size > 0;

        if (candidates.size === 0 && !writeIndex) {
            return { written, erased, skipped, bytes, at };
        }

        // 1. Article files. Sorted ids, so `written`/`skipped` are deterministic and byte-testable.
        for (const id of [...candidates].sort()) {
            const article = byId.get(id);
            const file = knowledgeArticleFileOf(root, id);

            if (article === undefined) {
                dirty.delete(id);
                removed.delete(id);

                if (unadoptable.has(id)) {
                    // The adoption step above reported it and failed on it; the file stays, and
                    // `skipped` says this pass touched nothing.
                    skipped.push(id);

                    continue;
                }

                // The engine no longer holds it: queue the erasure, which happens after EVERY
                // write (deletions last, ./persistence.ts:78-89). On a forced pass this is the
                // `deleted` list — an id with a file and no article, which only a DELIBERATE
                // removal can reach, because every other disk-only id was adopted above.
                erases.push({ id, file });

                if (force) deleted.push(id);

                continue;
            }

            const payload = knowledgeArticlePayloadOf(article);
            const digest = harnessShardDigest(payload);
            const previous = stamps.get(file);

            if (previous !== undefined && previous.digest === digest && witnessMatches(previous, file)) {
                dirty.delete(id);
                removed.delete(id);
                skipped.push(id);

                continue;
            }

            // The bytes on disk are not the bytes the engine implies. On a repair pass that is a
            // finding worth naming — UNLESS this pass just adopted the file, which has its own
            // (adopted, not divergent) line.
            if (force && !created.includes(id)) {
                const missing = !fs.existsSync(file);

                modified.push(id);
                passDiagnostics.push(
                    missing
                        ? `The knowledge article "${id}" has no file ("${path.basename(file)}" is missing); the engine is authoritative for what the store holds, so the file is written.`
                        : `The knowledge article file "${path.basename(file)}" no longer matches the article the engine holds; the engine is authoritative for content, so the file is rewritten.`
                );
            }

            try {
                writeHarnessDatabaseFile(directory, file, payload, writeOptions);
                stamps.set(file, harnessShardCommitStampOf(file, digest, payload));
                written.push(id);
                bytes += Buffer.byteLength(payload, 'utf8');
                dirty.delete(id);
                removed.delete(id);
            } catch (error) {
                // Keep the article DIRTY: the change is still in the engine and the next pass
                // retries it. `removed` is cleared so a stale erase request cannot delete the file
                // this pass was trying to write.
                dirty.add(id);
                removed.delete(id);
                noteFailure(file, error, id);
            }
        }

        // 2. Erasures, once no write is in flight. `fs.rmSync(force)` is ENOENT-quiet, so an article
        // that never reached disk costs nothing; `erased` counts only a file that actually went
        // away (the stamp map answers it without a syscall for files this store committed).
        for (const pending of erases) {
            const known = stamps.has(pending.file);
            const existed = known || fs.existsSync(pending.file);

            // On a repair pass, a file still standing for an article the engine no longer holds is
            // the `deleted` finding: the engine deleted the article and the directory never caught
            // up (the window a crash leaves behind).
            if (force && existed) {
                passDiagnostics.push(
                    `The knowledge directory still holds "${path.basename(pending.file)}" for an article the engine removed; the engine is authoritative for what the store holds, so the file is erased.`
                );
            }

            try {
                if (existed) fs.rmSync(pending.file, { force: true });

                stamps.delete(pending.file);

                if (existed) erased.push(pending.id);
                else skipped.push(pending.id);
            } catch (error) {
                // Put it back: the file is still there, and the next pass retries the erase.
                removed.add(pending.id);
                noteFailure(pending.file, error, pending.id);
            }
        }

        // 3. `index.json` LAST — and not at all when this pass failed something, so the accelerator
        // never describes an article whose file is not durable. `indexDirty` stays set, so the
        // retry pass rewrites it.
        if (writeIndex && failure === undefined) {
            index = knowledgeIndexOf(state.articles, at, state.storeRev);

            const payload = knowledgeIndexPayloadOf(index);
            const digest = harnessShardDigest(payload);
            const file = knowledgeIndexFileOf(root);
            const previous = stamps.get(file);

            if (previous !== undefined && previous.digest === digest && witnessMatches(previous, file)) {
                indexDirty = false;
            } else {
                try {
                    writeHarnessDatabaseFile(directory, file, payload, writeOptions);
                    stamps.set(file, harnessShardCommitStampOf(file, digest, payload));
                    bytes += Buffer.byteLength(payload, 'utf8');
                    indexDirty = false;
                } catch (error) {
                    indexDirty = true;
                    noteFailure(file, error);
                }
            }
        }

        // The gate anchor moves only when a pass actually ran (./sessions.ts:6249-6250 stamps the
        // window inside the write, not inside the notification).
        committedAt = startedAt;
        firstCommitPending = false;

        // ---- the retained view of the directory ---------------------------------------------
        // A forced pass looked at BOTH sides and, when it did not fail, everything it found is now
        // repaired: the retained set is dropped as one unit, which is the store's own proof that
        // its view and the files agree. Any other pass only ADDS what it saw (deduplicated, so a
        // failure that survives eight passes cannot bury the log in repeats of one line).
        if (force && failure === undefined) {
            divergence.length = 0;
        } else {
            for (const line of passDiagnostics) {
                if (!divergence.includes(line)) divergence.push(line);
            }
        }

        const report: KnowledgeCommitReport = {
            written,
            erased,
            skipped,
            bytes,
            at,
            // ONLY on a forced pass, and sorted ascending: the caller asserting on it wants a
            // stable order, and the order the pass happened to walk the directory in is not one.
            ...(force
                ? {
                      due: {
                          created: [...created].sort(),
                          modified: [...modified].sort(),
                          deleted: [...deleted].sort()
                      }
                  }
                : {}),
            ...(failure === undefined ? {} : { failure })
        };

        emit?.({ kind: 'commit', directory, report, diagnostics: passDiagnostics });

        return report;
    };

    const clearTimer = (): void => {
        if (timer === undefined) return;

        clearTimeout(timer);
        timer = undefined;
    };

    // One trailing write per store: armed only when none is pending, so a burst shares a flush,
    // and `unref()`'d because a pending commit is work the process may legitimately die with
    // (./sessions.ts:6291-6294). The deferred pass runs UNCONDITIONALLY — re-testing the interval
    // inside the timer would drop the change forever under a pinned clock.
    const scheduleCommit = (delayMs: number): void => {
        if (disposed || timer !== undefined) return;

        timer = setTimeout(
            () => {
                timer = undefined;

                if (disposed) return;

                // The pass is synchronous; the promise only carries its report. A rejection here
                // is a bug rather than a write failure (write failures land in `report.failure`),
                // and it must never become an unhandled rejection.
                void commit().catch(() => undefined);
            },
            Math.max(0, delayMs)
        );

        timer.unref?.();
    };

    /**
     * The refusal a disposed store answers to a durability request. A `KnowledgeCommitReport`
     * cannot carry it: `failure` means "a write was attempted and the file said no", and here NO
     * write was attempted at all, so a zero-work success would be read as "everything is on disk"
     * by a caller that has just lost an article. `HarnessPersistenceError` is the shape every other
     * failure in this file takes, the DIRECTORY is the file-equivalent the message can name, and
     * the remedy is the only one that exists: load a store over the same root again.
     */
    const refuseDisposed = (): HarnessPersistenceError =>
        persistenceFailure(
            directory,
            `The knowledge store for "${directory}" is disposed, so it no longer commits: nothing written through it will reach the files. Load a store with loadKnowledgeFileStore({ root }) and write through that one.`
        );

    /**
     * The pass engine: run a pass, joining the one already in flight instead of starting a second —
     * and answering with the report that ACTUALLY DID THE WORK. That is not necessarily the pass
     * this call started: a caller arriving mid-pass joins bytes it cannot redo, and a forced caller
     * must not be handed a plain pass's shallow answer (a plain pass never looked at the directory).
     */
    const commitNow = async (commitOptions: { force?: boolean } = {}): Promise<KnowledgeCommitReport> => {
        const forced = commitOptions.force === true;

        if (forced) pendingForce = true;

        let best: KnowledgeCommitReport | undefined;

        for (let attempt = 0; attempt < FLUSH_MAX_PASSES; attempt += 1) {
            if (inFlight !== undefined) {
                const joined = await inFlight;

                best = preferReport(best, joined, forced);

                // A pass that surveyed the directory answers a forced request outright; a plain
                // pass answers a plain request once the store is quiet.
                if (joined.due !== undefined) break;
                if (!forced && !hasPendingWork()) break;

                // Otherwise this call still owes its own (deeper) pass: the pass we joined took the
                // force flag before we set it, so `pendingForce` is still standing for us.
                continue;
            }

            // The force flag is read synchronously, HERE, so a force request that arrives in the
            // same tick as this call lands in the pass below rather than in the microtask after it.
            const force = pendingForce;

            pendingForce = false;

            // One microtask of slack, so every caller that asks in THIS tick joins the same pass.
            // The pass itself is synchronous, so without the yield the first caller would already
            // have finished by the time the second asked, and a redundant second pass would run.
            const pass = Promise.resolve().then(() => {
                inFlight = undefined;

                return runCommitPass(force);
            });

            inFlight = pass;

            best = preferReport(best, await pass, forced);

            break;
        }

        // Every path above sets `best`; the fallback only keeps the return total (an idle answer,
        // because a loop that ran eight joins has nothing left to do).
        return (
            best ?? {
                written: [],
                erased: [],
                skipped: [],
                bytes: 0,
                at: new Date(Date.now()).toISOString()
            }
        );
    };

    /**
     * The PUBLIC `commit()`: a disposed store is refused before anything is read or armed
     * (`refuseDisposed`), which is also what keeps the older guarantee honest — a refused call
     * cannot resurrect the trailing timer, because it never reaches the pass that would arm it.
     *
     * `commitNow` is what the timer, the notification handler and `runBarrier` call instead: each of
     * those already decides about `disposed` for its own reasons (the timer and the notification
     * drop the work, the teardown flush is the one pass allowed to run AFTER `disposed` is set), and
     * routing them through the refusal would turn a clean shutdown into a rejected promise.
     */
    const commit = async (options?: { force?: boolean }): Promise<KnowledgeCommitReport> => {
        if (disposed) throw refuseDisposed();

        return commitNow(options);
    };

    // The notification handler: mark what moved, then decide WHEN the bytes move.
    const onNotification = (notification: KnowledgeStoreNotification): void => {
        if (disposed || loading) return;

        for (const id of notification.affectedArticles) {
            dirty.add(id);
            removed.delete(id);
        }

        for (const id of notification.removedArticles) {
            dirty.delete(id);
            removed.add(id);
        }

        // `reset`/`restore` replace the store, so a per-article delta is not the whole story.
        if (notification.reason === 'reset' || notification.reason === 'restore') resync = true;

        // The index is the store's own stamp: every committed operation moves the watermark it
        // describes, so it is due whenever anything was committed.
        indexDirty = true;

        if (intervalMs <= 0) {
            void commit().catch(() => undefined);

            return;
        }

        const now = Date.now();

        // Cold-start anchor (./sessions.ts:6232-6241): the first mutation of this store's life
        // commits however fast it follows the load, because the interval alone would swallow it.
        if (firstCommitPending || committedAt === 0 || now - committedAt >= intervalMs) {
            void commit().catch(() => undefined);

            return;
        }

        scheduleCommit(intervalMs - (now - committedAt));
    };

    // The barrier's ENGINE, deliberately unguarded: `dispose()` reaches it AFTER `disposed` is set,
    // and the teardown flush is the store's own last word rather than a durability request from a
    // caller that must be told the base stopped being live. Concurrent callers still join the one
    // running barrier, the barrier is cached while it runs, and a barrier against a quiet store
    // costs nothing — so calling it twice is always safe.
    const runBarrier = (): Promise<KnowledgeCommitReport> => {
        if (flushing !== undefined) return flushing;

        const run = (async (): Promise<KnowledgeCommitReport> => {
            // The trailing timer is not deferred work any more: this call IS the write.
            clearTimer();

            let last = await commitNow();
            let best = last;

            // A pass can leave work behind (a mutation landed while the barrier awaited, a forced
            // pass that queued a resync). Keep going until quiet; stop on a failure, which is
            // already in the report and must not be retried into a hot loop.
            for (let attempt = 0; attempt < FLUSH_MAX_PASSES; attempt += 1) {
                if (last.failure !== undefined || !hasPendingWork()) break;

                last = await commitNow();

                // The barrier answers with the pass that DID the work, so a trailing idle pass
                // cannot hide the one that wrote something. `false`: a barrier is a plain request
                // (`KnowledgeFlush` takes no force option), so bytes outrank a survey report.
                best = preferReport(best, last, false);
            }

            return best;
        })();

        flushing = run;

        const release = (): void => {
            if (flushing === run) flushing = undefined;
        };

        // Both branches clear the memo: a rejected barrier must not stay cached, or every later
        // caller would await the same rejection forever.
        void run.then(release, release);

        return run;
    };

    // The public barrier: the disposed refusal first, then the cached barrier.
    const flush = (): Promise<KnowledgeCommitReport> => {
        if (disposed) return Promise.reject(refuseDisposed());

        return runBarrier();
    };

    const dispose = async (): Promise<KnowledgeCommitReport | undefined> => {
        const owed = hasPendingWork();

        disposed = true;

        clearTimer();

        if (subscribed) {
            subscribed = false;
            unsubscribe();
        }

        // Nothing owed: no report to give, and no syscall performed. This is also what keeps a
        // SECOND `dispose()` idempotent — nothing is owed after the first one, so it answers
        // `undefined` instead of the refusal a `commit()`/`flush()` gets.
        if (!owed) return undefined;

        // UNGUARDED on purpose: `disposed` is already set, and this pass is the reason the caller
        // is allowed to say "the base is durable" about everything up to this point.
        return runBarrier();
    };

    const unsubscribe = engine.onStoreChange(onNotification);

    const loaded = engine.snapshot();

    emit?.({
        kind: 'loaded',
        directory,
        articles: loaded.articles.length,
        storeRev: loaded.storeRev,
        diagnostics
    });

    // Articles that arrived with an injected engine owe their first write even if nobody mutates
    // afterwards; the anchor makes that commit immediate.
    if (dirty.size > 0) void commit().catch(() => undefined);

    return {
        root,
        directory,
        engine,

        readIndex: () => ({
            version: index.version,
            savedAt: index.savedAt,
            articles: index.articles.map((entry) => ({ ...entry })),
            // Spread, not `storeRev: index.storeRev`, so an index loaded from a file that carried
            // no watermark reads back WITHOUT the key rather than with an `undefined` one — the
            // stored shape and the in-memory shape stay the same shape.
            ...(index.storeRev === undefined ? {} : { storeRev: index.storeRev })
        }),

        // Detached, so a caller that keeps the array and then runs a pass still holds what it saw,
        // and nothing it does to its copy can reach the store's view.
        diagnostics: () => [...divergence],

        commit,
        flush,
        dispose
    };
};

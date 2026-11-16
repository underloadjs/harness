// R3 guard: the ONE retired-conversation rule, stated as a truth table.
//
// WHY THIS FILE EXISTS
// --------------------
// A conversation DELETE is a soft delete: the store marks the thread row `inactive` and RETAINS
// the row, its turn rows, its transcript, its agent results and its journal lines
// (./sessions.ts `markDeletedThread`, ../harness.ts `deleteThread`). To stop a deleted
// conversation repainting a card after a refresh, ./api.ts `getSessionTurns` now drops the rows of
// a retired conversation from the turns page — the read the frontend's refresh performs
// (../frontend/view-api.ts `openSession` → `listTurns`, and ../frontend/ui/turns.ts groups one
// card per distinct `turn.threadId`).
//
// Dropping rows is the easy half. The precise SCOPE is the part a broad predicate gets wrong, and
// every wrong version here is one the UI would report as a NEW bug:
//   - filtering by ORIGIN instead of by the marker → the agent's `agent:<name>` lane rows vanish
//     from the page (they were never deleted, and the roster has never published that lane, so
//     nothing would ever bring them back);
//   - "a row is visible only if its conversation has a row" → every pre-thread document row, every
//     legacy run and every agent-lane row disappears (./threads.test.ts's pre-thread document case;
//     an `agent:<name>` conversation is never persisted as a thread row at all, ../types
//     `HarnessThreadSnapshot`). A `threadId` that merely has no row is a gap in the ledger, not a
//     deletion;
//   - `!== undefined` instead of an explicit null check → a restored row whose `threadId` is `null`
//     is used as a set key;
//   - reading the marker off the LIVE handle (`harness.threads()`) instead of the ledger/`core`
//     pair → it hides NOTHING, because the runtime does not name a retired row there (that mistake
//     is why this file asserts the two sources it does — see ./api-reads.ts `retiredThreadIdsOf`).
//
// The HTTP half of the same contract — a real DELETE, then the real reads, then the disc — is
// pinned in ./threads.test.ts (`thread HTTP contract` › "keeps a deleted conversation off the
// turns page while its rows stay durable"). This file is the exhaustive scope table, which an
// end-to-end run cannot enumerate because the store will not mint a thread-less turn or a turn on a
// conversation the record has no row for.
//
// Cross-references (the other halves of the same rule):
//   - ./api-reads.ts `retiredThreadIdsOf` / `discoverableTurnFilterOf` — the predicate under test,
//     and the comment there for what is deliberately NOT filtered (the usage fold, the queue, the
//     pending-action join, the identified reads).
//   - ./api.ts `getSessionTurns` — its only turn-list caller.
//   - ./sessions.ts `isThreadInactive` — the store's single-row copy of the SAME two sources, in
//     the same order; these helpers must stay scoped the way that method is.
//   - ./api.ts `threadRecordsOf` + ./sessions.ts `threadRoster` (~:4639) — the roster's copy of the
//     rule for the thread LIST reads.

import type { SessionRecord } from './sessions';
import { discoverableTurnFilterOf, retiredThreadIdsOf } from './api-reads';

// A DURABLE thread row (the second source), spelled through the store's own accessor so a type
// change is a compile error here rather than a fixture that quietly stops meaning anything. Both
// helpers read only `id` and `inactive`, so the doubles carry only those fields — on purpose: a
// helper that reached for another one (an `origin`, a `status`, a `messages` list) would read
// `undefined` and fail here instead of passing on a shape the real record happens to have.
type StoredThread = NonNullable<SessionRecord['core']['threads']>[number];

const storedThreadOf = (id: string, inactive?: true | false): StoredThread =>
    ({ id, ...(inactive === undefined ? {} : { inactive }) }) as unknown as StoredThread;

/** A record whose ledger holds exactly `ledger` and whose durable rows are exactly `rows`.
 *  Both sources are always present, so an assertion cannot pass on an uninitialized field. */
const recordOf = (ledger: string[] = [], rows: StoredThread[] = []): SessionRecord =>
    ({
        inactiveThreads: new Map(ledger.map((threadId) => [threadId, undefined])),
        core: { threads: rows }
    }) as unknown as SessionRecord;

// A TURN ROW, in the shape the predicate is actually called with: ./api-reads.ts
// `discoverableTurnFilterOf` takes `{ threadId?: string | null }`, and every fake below adds the
// `index` the assertion reads back. The shape is declared ONCE, on purpose — left to inference,
// `ALL_TURNS` becomes a union of the three literal row shapes, and TypeScript then rejects a row
// that legitimately names a conversation (TS2353, reported against the `{ index }` member) and
// rejects `ROOT_ABSENT` against the predicate's all-optional parameter (TS2559, the weak-type
// check). Both are type-level noise about a fixture list, not about behaviour. `threadId?` here is
// the SAME optionality the production parameter declares, and an annotation adds no key at
// runtime: `ROOT_ABSENT` still carries NO `threadId` property at all, which is the case it exists
// to pin (R3b), and `ROOT_NULL` still carries a real `null`.
type TurnRow = { index: number; threadId?: string | null };

// The turn list every scope assertion runs against: one row per case R3 names, in the order the
// page would serve them, with the index it would report.
const LIVE: TurnRow = { index: 0, threadId: 'thread-1' };
const RETIRED: TurnRow = { index: 1, threadId: 'thread-2' };
const AGENT: TurnRow = { index: 2, threadId: 'agent:probe' };
const ROOT_ABSENT: TurnRow = { index: 3 };
const ROOT_NULL: TurnRow = { index: 4, threadId: null };
const FOREIGN: TurnRow = { index: 5, threadId: 'thread-404' };
const ALL_TURNS: TurnRow[] = [LIVE, RETIRED, AGENT, ROOT_ABSENT, ROOT_NULL, FOREIGN];

/** The surviving indexes — the whole answer, so a wrong row cannot hide behind a right one. */
const visibleOf = (turns: readonly TurnRow[], record: SessionRecord): number[] => {
    const discoverable = discoverableTurnFilterOf(record);

    return turns.filter((turn) => discoverable(turn)).map((turn) => turn.index);
};

describe('retiredThreadIdsOf — the marker is the only thing that retires a conversation', () => {
    it('names the ledger keys and the rows marked inactive, and nothing else', () => {
        const record = recordOf(
            // The ledger: `thread-2` retired with a stamp, `thread-5` retired with NO stamp — the
            // `undefined` value ../types documents as independently optional. Only the KEYS count.
            ['thread-2', 'thread-5'],
            [
                storedThreadOf('thread-1'),
                storedThreadOf('thread-2', true),
                storedThreadOf('thread-3', false),
                storedThreadOf('thread-4')
            ]
        );

        // Exact set: `thread-3`'s `inactive: false` is the on-disk legacy spelling the reader
        // normalizes away, and an absent marker means active — so neither may retire anything, and
        // `thread-5` counts on the ledger's word alone.
        expect(retiredThreadIdsOf(record)).toEqual(new Set(['thread-2', 'thread-5']));
    });

    it('names nothing for a session that never deleted a conversation', () => {
        expect(retiredThreadIdsOf(recordOf([], [storedThreadOf('thread-1'), storedThreadOf('thread-2')]))).toEqual(
            new Set<string>()
        );
    });

    it('accepts a record with an empty ledger and no thread rows at all', () => {
        // A first-run session: `core.threads` is optional on the snapshot, and the read layer must
        // not reach through it.
        expect(retiredThreadIdsOf({ inactiveThreads: new Map(), core: {} } as unknown as SessionRecord)).toEqual(
            new Set<string>()
        );
    });

    it('reads each source exactly once per read, whatever the turn list', () => {
        // The performance characteristic the turns page needs: the retired set is built ONCE for a
        // request, so a large ledger costs one pass plus a set lookup per row — never a scan per
        // row. Counting the reads IS the assertion.
        let ledgerReads = 0;
        let rowReads = 0;
        const record = {
            get inactiveThreads() {
                ledgerReads += 1;

                return new Map([['thread-2', undefined]]);
            },
            get core() {
                rowReads += 1;

                return { threads: [storedThreadOf('thread-2', true)] };
            }
        } as unknown as SessionRecord;

        const discoverable = discoverableTurnFilterOf(record);

        expect(ALL_TURNS.filter((turn) => discoverable(turn))).toHaveLength(5);
        expect({ ledgerReads, rowReads }).toEqual({ ledgerReads: 1, rowReads: 1 });

        // And a built predicate keeps answering without touching either source again.
        expect(ALL_TURNS.filter((turn) => discoverable(turn))).toHaveLength(5);
        expect({ ledgerReads, rowReads }).toEqual({ ledgerReads: 1, rowReads: 1 });
    });
});

describe('discoverableTurnFilterOf — R3 scope, row by row', () => {
    it('drops the rows of a retired conversation and nothing else', () => {
        const record = recordOf(['thread-2'], [storedThreadOf('thread-1'), storedThreadOf('thread-2', true)]);

        // The whole page, exactly: only index 1 (`thread-2`, retired) is gone.
        expect(visibleOf(ALL_TURNS, record)).toEqual([0, 2, 3, 4, 5]);
    });

    it('is driven by EITHER source, since the store answers from either (isThreadInactive)', () => {
        // The ledger alone: a delete that has not reached the durable rows yet (the window
        // `applyInactiveLedger` exists for).
        expect(visibleOf([RETIRED], recordOf(['thread-2'], []))).toEqual([]);

        // The durable row alone: a document marked by a build that had no ledger, loaded into a
        // store whose ledger was never hydrated.
        expect(visibleOf([RETIRED], recordOf([], [storedThreadOf('thread-2', true)]))).toEqual([]);

        // Neither: the same row is served.
        expect(visibleOf([RETIRED], recordOf([], [storedThreadOf('thread-2')]))).toEqual([1]);
    });

    it('keeps an agent lane row: the rule keys on the marker, never on the origin', () => {
        const record = recordOf(['thread-2'], [storedThreadOf('thread-2', true)]);

        // (a) A row of `agent:probe` is still served. That conversation has NO thread row of its own
        // at all (../types `HarnessThreadSnapshot`), so the only way it can disappear is a filter
        // shaped on the origin — and an agent lane has no roster row to bring it back. A delete
        // REFUSES it (./sessions.ts `deleteThread` answers 400), so no marker can ever name it.
        expect(visibleOf([AGENT], record)).toEqual([2]);

        // The converse, stated so the rule cannot quietly become origin-based: a hypothetical
        // retired AGENT conversation is hidden by the MARKER like any other. Nothing mints one
        // today; this is what the predicate does if something ever does.
        expect(visibleOf([AGENT], recordOf(['agent:probe']))).toEqual([]);
    });

    it('keeps a row with no conversation, whether the field is absent or null', () => {
        const record = recordOf(['thread-2']);

        // (b) Absent (`undefined`) — a legacy run, or a harness handle without the thread API
        // (./sessions.ts `threadsSupported`).
        expect(visibleOf([ROOT_ABSENT], record)).toEqual([3]);

        // (b, durable spelling) `null` — what a hand-written or half-restored document can carry.
        // A `!== undefined` shorthand would let this through as a SET KEY; the explicit null check
        // is why it stays visible.
        expect(visibleOf([ROOT_NULL], record)).toEqual([4]);

        // Rows that name no conversation are visible even when NOTHING is retired.
        expect(visibleOf([ROOT_ABSENT, ROOT_NULL], recordOf())).toEqual([3, 4]);
    });

    it('keeps every row of a live host conversation and of one the record has no row for', () => {
        const record = recordOf(['thread-2'], [storedThreadOf('thread-1'), storedThreadOf('thread-2', true)]);

        // (c) The live sibling — the case that makes "the page went empty" a scoping failure rather
        // than a passing test.
        expect(visibleOf([LIVE], record)).toEqual([0]);

        // (d) A `threadId` with NO row anywhere — a foreign id, a row pruned by the thread-record
        // cap (../core/thread.ts `MAX_THREAD_RECORDS`), or a typo recorded before the guard. That
        // is a gap in the ledger, not a deletion: the filter invents no stricter rule.
        expect(visibleOf([FOREIGN], record)).toEqual([5]);
    });

    it('serves the whole ledger while no conversation is retired — including a false-marked row', () => {
        // The fast path (an empty retired set) must not change any answer: every row of a session
        // that never deleted anything stays exactly where it was, retired-looking rows included.
        const record = recordOf([], [storedThreadOf('thread-1'), storedThreadOf('thread-2', false)]);

        expect(visibleOf(ALL_TURNS, record)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('scopes to the retired conversations, not to their neighbours', () => {
        // Two retired conversations, one live one, interleaved by index so an ordering accident
        // cannot hide a wrong answer: only the retired conversations' rows leave the page.
        const record = recordOf(['thread-1', 'thread-3'], [
            storedThreadOf('thread-1', true),
            storedThreadOf('thread-2'),
            storedThreadOf('thread-3', true)
        ]);

        expect(
            visibleOf(
                [
                    { index: 0, threadId: 'thread-1' },
                    { index: 1, threadId: 'thread-2' },
                    { index: 2, threadId: 'thread-3' },
                    { index: 3, threadId: 'thread-2' }
                ],
                record
            )
        ).toEqual([1, 3]);
    });
});

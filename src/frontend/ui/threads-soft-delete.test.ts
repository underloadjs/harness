// T-W3/T-W6/F7 — the roster-side half of the deleted-conversation verdict (pure functions).
//
// The board's DOM pass (./turns.ts `syncDeletedThreads`, `paintPersistentMarkers`) asks
// exactly these questions; they live here, next to the roster adapter that reads the
// marker, so the rule is stated once and the board stays a renderer. The evidence, and
// what deliberately is NOT evidence, is documented at ./threads.ts `rosterDeletionsOf`.
//
// T-W6 added the half the first pass could not reach: the SESSION HEADER's retired list
// (`SessionView.inactiveThreads`, forwarded from `SessionResource.inactive_thread_ids` by
// ../view-api.ts `sessionViewOf`). Every roster projection hides a soft-deleted row, so a
// RELOAD — a board that never watched the delete — gets its evidence from membership in that
// list, joined onto the roster by `sessionThreadsOf`. The tests below pin that join: positive
// on a first roster, revived by a roster row that names the conversation live, and silent for a
// session that never retired one.
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts ui/threads-soft-delete.test.ts

import { describe, expect, it } from 'vitest';
import type { SessionThreadEntry } from './threads';
import {
    deletedThreadIdsOf,
    inactiveThreadIdsOf,
    rosterDeletionsOf,
    revivedThreadIdsOf,
    sessionThreadsOf
} from './threads';

const entry = (overrides: Partial<SessionThreadEntry> & { id: string }): SessionThreadEntry => ({
    agent: 'Workspace',
    origin: 'host',
    status: 'idle',
    sequence: 1,
    ...overrides
});

describe('F7 — the soft-delete marker on the wire', () => {
    it('reads `inactive: true` as the deleted marker, and nothing else as one', () => {
        // The two shapes the server sends: `SessionStore.deleteThread` keeps the row and
        // writes `inactive`/`inactiveAt`; every other row omits it (or says `false`).
        const roster = sessionThreadsOf({
            threads: [
                { id: 'thread-13', agent: 'Instruct', sequence: 1, status: 'idle' },
                {
                    id: 'thread-15',
                    agent: 'Workspace',
                    sequence: 2,
                    status: 'idle',
                    inactive: true,
                    inactiveAt: 1_794_867_170_178
                },
                { id: 'thread-16', agent: 'Workspace', sequence: 3, status: 'idle', inactive: false },
                // A malformed marker is "the server did not report a deletion" — it must
                // not hide a row, and it must not crash the adapter either.
                { id: 'thread-17', agent: 'Reviewer', sequence: 4, status: 'idle', inactive: 'yes' }
            ]
        });

        expect(roster.map((row) => [row.id, row.deleted])).toEqual([
            ['thread-13', undefined],
            ['thread-15', true],
            ['thread-16', undefined],
            ['thread-17', undefined]
        ]);
        expect(deletedThreadIdsOf(roster)).toEqual(['thread-15']);
    });

    it('reads the marker on the compact roster the display wire actually sends', () => {
        // `SessionView.threadViews` (../server/protocol.ts) is the shape the browser gets;
        // `threads` above is the raw snapshot. One adapter, one answer.
        const roster = sessionThreadsOf({
            threadViews: [{ id: 'thread-16', agent: 'Workspace', sequence: 2, status: 'idle', inactive: true }]
        });

        expect(roster.map((row) => [row.id, row.deleted])).toEqual([['thread-16', true]]);
    });
});

describe('F7 — which conversations a roster pair reports as gone', () => {
    it('names the conversations the new roster ships with the marker', () => {
        const next = [entry({ id: 'thread-13' }), entry({ id: 'thread-15', deleted: true })];

        // A FIRST roster (nothing to compare with) still answers, because the marker is
        // the only evidence a reload can get.
        expect(rosterDeletionsOf([], next)).toEqual(['thread-15']);
    });

    it('names an id a non-empty roster dropped, in the order the old roster had', () => {
        const previous = [entry({ id: 'thread-13' }), entry({ id: 'thread-15' }), entry({ id: 'thread-16' })];
        const next = [entry({ id: 'thread-13' }), entry({ id: 'thread-16' })];

        expect(rosterDeletionsOf(previous, next)).toEqual(['thread-15']);
    });

    it('treats an empty roster as no evidence at all', () => {
        // A payload without the list, or a board that has not been told anything yet: an
        // id it omits was never on screen, so "gone" cannot be concluded.
        const previous = [entry({ id: 'thread-13' }), entry({ id: 'thread-15' })];

        expect(rosterDeletionsOf(previous, [])).toEqual([]);
    });

    it('retracts a verdict for a conversation the new roster names live again', () => {
        // A resume (or an undone delete) re-ships the row WITHOUT the marker, so the
        // removal join alone must not keep the conversation hidden forever.
        const previous = [entry({ id: 'thread-13' }), entry({ id: 'thread-15' })];
        const deleted = [entry({ id: 'thread-13' }), entry({ id: 'thread-15', deleted: true })];

        expect(rosterDeletionsOf(previous, deleted)).toEqual(['thread-15']);

        // Same ids, marker gone: the frame that deleted it is retracted, not remembered.
        expect(rosterDeletionsOf(deleted, previous)).toEqual([]);
    });

    it('combines the marker and the removal join in one frame', () => {
        // thread-15 arrives stamped deleted AND thread-16 has already left the list; both
        // are verdicts of this one frame, marker ids first, then the removals in the old
        // roster's order.
        const previous = [entry({ id: 'thread-13' }), entry({ id: 'thread-15' }), entry({ id: 'thread-16' })];
        const next = [entry({ id: 'thread-13' }), entry({ id: 'thread-15', deleted: true })];

        expect(rosterDeletionsOf(previous, next)).toEqual(['thread-15', 'thread-16']);
    });

    it('revives exactly the known ids the new roster names live', () => {
        const known = new Set(['thread-13', 'thread-15', 'thread-16']);
        const next = [entry({ id: 'thread-13' }), entry({ id: 'thread-15', deleted: true })];

        // thread-13 is addressable again; thread-15 keeps its verdict; thread-16 is not in
        // this roster at all, so nothing retracts it.
        expect(revivedThreadIdsOf(next, known)).toEqual(['thread-13']);
        expect(revivedThreadIdsOf([], known)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// T-W6: the SESSION HEADER is the deletion evidence a reload can actually get.
//
// `threadRoster` (src/server/sessions.ts:4893, mirrored by ../server/api.ts `threadRecordsOf`
// :4834) hides a retired row, so for a board that never watched the delete the removal join has
// nothing to compare and the row-level marker is never shipped. The store therefore publishes the
// retired ids beside the roster (`SessionSnapshot.inactiveThreads` / `SessionView.inactiveThreads`,
// ../server/protocol.ts:774/:964, REST twin `SessionResource.inactive_thread_ids`), and
// `sessionThreadsOf` turns membership into the one marker spelling the board consumes.
// ---------------------------------------------------------------------------

describe('F7 — the retired list is read from the session header', () => {
    it('answers "no deletions named" for every shape that names none', () => {
        // A payload that predates F7, a non-object, a non-array and an EMPTY list are the same answer:
        // `[]`, which must hide nothing. A normal session is therefore untouched by the join.
        expect(inactiveThreadIdsOf(undefined)).toEqual([]);
        expect(inactiveThreadIdsOf(null)).toEqual([]);
        expect(inactiveThreadIdsOf('session')).toEqual([]);
        expect(inactiveThreadIdsOf({})).toEqual([]);
        expect(inactiveThreadIdsOf({ inactiveThreads: 'thread-15' })).toEqual([]);
        expect(inactiveThreadIdsOf({ inactiveThreads: [] })).toEqual([]);
    });

    it('keeps only usable ids, deduplicated in the server order', () => {
        // The server sorts by id (../server/sessions.ts `inactiveThreadIdsOf`); the client re-reads and
        // de-dupes without re-sorting, because the roster's and the ledger's order stay the server's.
        expect(
            inactiveThreadIdsOf({
                inactiveThreads: ['thread-15', '', '   ', 7, null, 'thread-16', 'thread-15', undefined]
            })
        ).toEqual(['thread-15', 'thread-16']);
    });
});

describe('F7 — the retired list joins the roster as positive evidence', () => {
    // A roster PAGE row exactly as `threadRoster` ships one: `origin: 'host'` is on the wire, and the
    // tuple stays narrow enough to feed `rosterDeletionsOf` directly (the ids it drops in are the same
    // shape the adapter reads back out).
    const liveRow = (id: string, agent: string, sequence: number) => ({
        id,
        agent,
        origin: 'host' as const,
        status: 'idle' as const,
        sequence
    });

    it('names a retired id as deleted on a FIRST roster, with no previous frame and no roster row', () => {
        // THE RELOAD CASE: the roster page omits thread-15 entirely (the store retains the row and
        // `threadRoster` hides it), so `rosterDeletionsOf` has no previous roster to diff and the
        // removal join cannot fire. Membership alone decides.
        const roster = sessionThreadsOf({
            threadViews: [liveRow('thread-13', 'Instruct', 1), liveRow('thread-16', 'Workspace', 2)],
            inactiveThreads: ['thread-15']
        });

        expect(roster.map((row) => [row.id, row.deleted])).toEqual([
            ['thread-13', undefined],
            ['thread-16', undefined],
            ['thread-15', true]
        ]);
        expect(deletedThreadIdsOf(roster)).toEqual(['thread-15']);

        // Positive on the BASELINE frame — the case the roster-baseline rule exists to survive.
        expect(rosterDeletionsOf([], roster)).toEqual(['thread-15']);
    });

    it('synthesizes ONE honest partial for a retired id nothing names', () => {
        // The retired list carries bare ids: no agent, no label, no status, no invocation. The entry
        // exists to carry the marker into `deletedThreadIdsOf`, so every other field is the explicit
        // "not knowable" shape — and `label: 'T?'` (../ui/threads.ts `UNKNOWN_THREAD_LABEL`) means a
        // retired id consumes NO per-agent ordinal, which is asserted next.
        const roster = sessionThreadsOf({
            threadViews: [liveRow('thread-13', 'Instruct', 1)],
            inactiveThreads: ['thread-15']
        });

        expect(roster[1]).toEqual({
            id: 'thread-15',
            agent: '',
            origin: 'host',
            status: 'idle',
            sequence: 2,
            label: 'T?',
            deleted: true
        });
    });

    it('does not renumber a live conversation whose retired sibling shares its agent', () => {
        // The legacy label pass derives `WE1`, `WE2`, … per agent CODE from roster order. A retired
        // Workspace conversation must not consume an ordinal — a live Workspace row keeps the label the
        // reader knows.
        const roster = sessionThreadsOf({
            threadViews: [liveRow('thread-13', 'Workspace', 1), liveRow('thread-16', 'Workspace', 2)],
            inactiveThreads: ['thread-15']
        });

        expect(roster.map((row) => [row.id, row.label])).toEqual([
            ['thread-13', 'WE1'],
            ['thread-16', 'WE2'],
            ['thread-15', 'T?']
        ]);
    });

    it('marks a retired id the invalid-transcript roster synthesized', () => {
        // The C5 invalid roster can be the only place an id appears; the retired list is not a roster
        // row either, so the two header lists stack: the conversation stays inspectable (its `invalid`
        // record) AND stops owning board rows (the marker).
        const roster = sessionThreadsOf({
            threadViews: [liveRow('thread-13', 'Instruct', 1)],
            invalidThreads: [{ id: 'thread-15', agent: 'Workspace', error: 'unreadable', messages: null }],
            inactiveThreads: ['thread-15']
        });

        expect(roster.map((row) => [row.id, row.deleted, row.invalid?.id])).toEqual([
            ['thread-13', undefined, undefined],
            ['thread-15', true, 'thread-15']
        ]);
        expect(deletedThreadIdsOf(roster)).toEqual(['thread-15']);
    });

    it('still names the deletions when the roster holds no live conversation at all', () => {
        // Every host conversation retired: the roster answers an EMPTY list (the store keeps the rows),
        // and the header list is the only thing left. `sessionThreadsOf` reads a roster ARRAY — empty
        // counts, a missing key does not — so the retired entries are the whole roster.
        const roster = sessionThreadsOf({ threadViews: [], inactiveThreads: ['thread-15', 'thread-16'] });

        expect(roster.map((row) => [row.id, row.deleted])).toEqual([
            ['thread-15', true],
            ['thread-16', true]
        ]);
        expect(rosterDeletionsOf([], roster)).toEqual(['thread-15', 'thread-16']);

        // A payload that carries NO roster key at all is the different case, and it stays silent: the
        // adapter answers "this document has no roster" and the board renders what it always did.
        expect(sessionThreadsOf({ inactiveThreads: ['thread-15'] })).toEqual([]);
        expect(deletedThreadIdsOf(sessionThreadsOf({ inactiveThreads: ['thread-15'] }))).toEqual([]);
    });

    it('infers nothing for a session that never retired one', () => {
        // The acceptance rule for a normal conversation: an absent list AND an explicit empty one leave
        // the roster byte-identical to the rows the server named — no synthesized entry, no verdict.
        const rows = [liveRow('thread-13', 'Instruct', 1), liveRow('thread-16', 'Workspace', 2)];

        for (const document of [{ threadViews: rows }, { threadViews: rows, inactiveThreads: [] }]) {
            const roster = sessionThreadsOf(document);

            expect(roster.map((row) => [row.id, row.deleted])).toEqual([
                ['thread-13', undefined],
                ['thread-16', undefined]
            ]);
            expect(deletedThreadIdsOf(roster)).toEqual([]);
            expect(rosterDeletionsOf([], roster)).toEqual([]);
        }
    });

    it('lets a roster row that names the id live win over the retired list — the revival rule', () => {
        // A host resume clears the store's ledger key AND the row marker in the SAME call
        // (`reactivateThreadRow`, src/server/sessions.ts:5140-5163), so a document can name the id in
        // the retired list one frame before it stops. The roster is the newer word: marking that row
        // deleted would hide a resumed conversation forever, because `revivedThreadIdsOf` retracts only
        // an id the roster names WITHOUT the marker.
        const before = sessionThreadsOf({
            threadViews: [liveRow('thread-13', 'Instruct', 1)],
            inactiveThreads: ['thread-15']
        });
        const resumed = sessionThreadsOf({
            threadViews: [liveRow('thread-13', 'Instruct', 1), liveRow('thread-15', 'Workspace', 2)],
            inactiveThreads: ['thread-15']
        });

        expect(deletedThreadIdsOf(resumed)).toEqual([]);
        expect(rosterDeletionsOf(before, resumed)).toEqual([]);
        expect(revivedThreadIdsOf(resumed, new Set(['thread-15']))).toEqual(['thread-15']);

        // The settled post-resume document: the header list is gone with the ledger key, and the row is
        // still live (no entry synthesized, nothing marked).
        const settled = sessionThreadsOf({
            threadViews: [liveRow('thread-13', 'Instruct', 1), liveRow('thread-15', 'Workspace', 2)]
        });

        expect(settled.map((row) => [row.id, row.deleted])).toEqual([
            ['thread-13', undefined],
            ['thread-15', undefined]
        ]);
        expect(revivedThreadIdsOf(settled, new Set(['thread-15']))).toEqual(['thread-15']);
    });

    it('keeps the verdict when the roster forwards the marked row AND the header names the id', () => {
        // The two positive spellings agree on one conversation: `threadRoster` normally hides it, but a
        // roster that forwards the row states the same fact. The marker on the row is decisive, so the
        // header list cannot resurrect it.
        const roster = sessionThreadsOf({
            threadViews: [
                liveRow('thread-13', 'Instruct', 1),
                { ...liveRow('thread-15', 'Workspace', 2), inactive: true, inactiveAt: 1_794_867_170_178 }
            ],
            inactiveThreads: ['thread-15']
        });

        expect(roster.map((row) => [row.id, row.deleted])).toEqual([
            ['thread-13', undefined],
            ['thread-15', true]
        ]);
        expect(rosterDeletionsOf([], roster)).toEqual(['thread-15']);
    });

    it('re-asserts the verdict on a roster frame that carries no retired list', () => {
        // A frame assembled WITHOUT the header field (an older server, a roster-only answer) must not
        // resurrect a conversation the previous document reported gone. The marked entry leaves `next`,
        // so the REMOVAL join re-draws the identical verdict from the previous roster.
        const retired = sessionThreadsOf({
            threadViews: [liveRow('thread-13', 'Instruct', 1), liveRow('thread-16', 'Workspace', 2)],
            inactiveThreads: ['thread-15']
        });
        const noList = [liveRow('thread-13', 'Instruct', 1), liveRow('thread-16', 'Workspace', 2)];

        expect(rosterDeletionsOf(retired, noList)).toEqual(['thread-15']);
        expect(revivedThreadIdsOf(noList, new Set(['thread-15']))).toEqual([]);

        // The same id named LIVE by that frame is what revives it — not the absence of the list.
        const resumed = [...noList, liveRow('thread-15', 'Workspace', 3)];

        expect(rosterDeletionsOf(retired, resumed)).toEqual([]);
        expect(revivedThreadIdsOf(resumed, new Set(['thread-15']))).toEqual(['thread-15']);
    });
});

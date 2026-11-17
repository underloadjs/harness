// Persistent agent threads (R2/R5/R6/R7) — the UI layer.
//
// TERMINOLOGY (mirrors src/types/index.ts "Persistent agent threads"):
//   - `HarnessThread` / `HarnessThreadInfo` = INVOCATION identity. One row per
//     non-root RUN inside a `SessionTurn` (ui/turns.ts `.thread-row`). Its id
//     changes every time an agent is invoked and it is what a `#` reference binds
//     to (`AgentBlockDescriptor.threadId`).
//   - a RUNTIME thread (`SessionSnapshot.threads[]`, `SessionTurn.threadId`) is the
//     PERSISTENT conversation. Its id is stable for the thread's whole life and two
//     sequential turns submitted into it are the SAME conversation, not two.
//
// This module owns everything that can be decided without touching the DOM owner
// (main.ts) or the turn board (ui/turns.ts):
//   - reading the runtime roster and per-turn thread identity STRUCTURALLY, so the
//     UI works against a server that does not send them yet (additive/fallback:
//     `sessionThreadsOf` returns [] and `turnThreadIdOf` returns undefined);
//   - the routing decision for the next submit (new thread vs continue vs steer vs
//     connected new thread). It is a pure function so the composer's promise and
//     the POST body can never disagree;
//   - the canonical display labels the board stamps on a conversation's tile badge
//     and on a `#` reference.
//
// The compact `.thread-strip` DOM band that used to be built here is REMOVED: it
// duplicated the transcript's own `.tile-thread` badge and cost a permanent row of
// height. Thread focus is now expressed by the expanded tile plus the composer's
// routing label only (see main.ts `createView`).
//
// Server contract this file is written against (agreed, additive):
//   SessionSnapshot.threads?: Array<{
//       id: string; agent: string; origin: 'host'; status: 'idle'|'running'|'stopped';
//       sequence: number; ownerThreadId?: string; label?: string; invocationId?: string;
//       originTurnId?: string; originInvocationId?: string; references?: unknown[];
//       invocationIds?: string[];
//   }>
//   SessionSnapshot.invalidThreads?: SessionInvalidThread[]   // C4/C5, additive
//       = Array<{ id; label?; agent?; error: string; messages: unknown }>
//       (src/server/protocol.ts; aliased below as `InvalidThreadRecord`)
//   SessionSnapshot.inactiveThreads?: string[]               // F7/T-W6, additive
//       = the ids of the SOFT-DELETED conversations the store RETAINS. Absent when the session never
//       deleted one. It is a sibling of the roster, never a row inside it: `threadRoster`
//       (src/server/sessions.ts:4893) hides those rows, so this list is the deletion's only trace for
//       a client that did not watch it (src/server/protocol.ts:774; the display twin
//       `SessionView.inactiveThreads` :964, the REST twin `SessionResource.inactive_thread_ids`
//       ../shared/harness-api.ts:1460, forwarded by ./view-api.ts `sessionViewOf`).
//   SessionTurn.threadId?: string          // the turn's persistent thread
//   SubmitTaskRequest.threadId?: string    // absent = create a NEW thread
//   POST   /sessions/:id/threads/:threadId/cancel -> { cancelled, thread_id, session_id, status, dropped_queued_tasks, revision }
//   DELETE /sessions/:id/threads/:threadId        -> { deleted, thread_id, session_id, removed_descendants, removed_turns, revision }
//
// The persisted `HarnessThreadSnapshot` (src/types/index.ts) is a DIFFERENT shape
// (snapshot v1, with `messages`); it is not rendered here. A client must not join
// the two by assumption: the runtime roster is the live view.

import { agentCodeOf } from './agent-label';
// Type-only: the browser bundle never loads server code, and this import is erased at
// build time (same pattern as ui/thread-transcript.ts and contract.ts).
import type { SessionInvalidThread } from '../../server/protocol';

// One live persistent thread, as the session snapshot reports it. Every field is
// validated on read (see sessionThreadsOf) because the roster is server data and a
// malformed entry must never break the transcript.
export type SessionThreadEntry = {
    id: string;
    agent: string;
    // 'host' = an independent conversation the UI may focus/stop/delete;
    // 'agent' = an agent's DEFAULT conversation. The protocol omits defaults from
    // `SessionSnapshot.threads`, but a server that includes one must not offer
    // stop/delete for it (it is not deletable; reset the session instead).
    origin: 'agent' | 'host';
    // 'running' = a run is active in this thread; 'stopped' = the host halted it
    // (continuing it resumes the conversation); 'idle' = live but not working.
    // 'paused' = a PLUGIN parked the conversation at a turn boundary and the run is
    // still attached (types/index.ts `HarnessThreadStatus`). The board renders it as a
    // waiting conversation, never as an error or as running.
    status: 'idle' | 'running' | 'paused' | 'stopped';
    // Creation order within the session (monotonic, not wall clock).
    sequence: number;
    label?: string;
    // Persistent parent thread (the requester that spawned/owned this one).
    ownerThreadId?: string;
    // Invocation id of the LATEST run, i.e. the join key to `HarnessEvent.thread.id`
    // and to `AgentResultBlock.threadId`. Never used as a persistent identity.
    invocationId?: string;
    // The turn (and root invocation) that opened this thread, when the server
    // recorded it. Display-only provenance; the board uses `SessionTurn.threadId`.
    originTurnId?: string;
    originInvocationId?: string;
    // EVERY invocation id the conversation ran, oldest first (additive). The two
    // slots above name only the LATEST run and the first TURN; a delegated child has
    // no turn of its own, so after it is resumed neither names the invocation that
    // created its card. This is the server's persisted invocation→thread map, and it
    // is what the board joins a HISTORICAL invocation card on — live and after a
    // fresh hydration. Absent on a payload that predates it: the board then keeps
    // only what it already learned and never guesses from task text.
    invocationIds?: readonly string[];
    // The thread's committed transcript (`SessionThread.messages`). A runtime child
    // has NO SessionTurn of its own (its work is recorded inside its parent's turn),
    // so this is the only way the UI can render that conversation (S2). Kept as an
    // opaque array: the board renders role/content defensively.
    // T5 R1: on the DISPLAY wire the roster is `SessionView.threadViews` (protocol.ts:408) and
    // carries NO messages — the transcript is the biggest payload class on the raw surface — so
    // `messages` is absent there and the three compact fields below replace it. A raw snapshot
    // document (the explicit export read) still carries the transcript entries themselves.
    messages?: readonly unknown[];
    // How many transcript entries the conversation holds, never their content
    // (`SessionThreadView.messageCount`).
    messageCount?: number;
    // True when a transcript read would return anything (`SessionThreadView.hasTranscript`): the
    // honest signal for "offer the transcript control" without pulling the transcript.
    hasTranscript?: boolean;
    // Bounded last-message preview (`SessionThreadView.preview`), so a roster-only child shows
    // something before its transcript is read.
    preview?: string;
    // T-W3/T-W6 F7: the server's SOFT-DELETE verdict for this conversation, in the ONE spelling the
    // board consumes (`turns.ts` `deletedThreadIdsOf`/`isConversationDeleted`). Two sources set it, and
    // they are deliberately different shapes because the two facts are different:
    //   1. MEMBERSHIP in the session header's retired list (`SessionView.inactiveThreads`,
    //      ../server/protocol.ts:964 / `SessionResource.inactive_thread_ids`,
    //      ../shared/harness-api.ts:1460) — THE LIVE PATH. The store retires a conversation by marking
    //      its row `inactive`/`inactiveAt` and RETAINING it (`SessionStore.deleteThread` →
    //      `markDeletedThread`, src/server/sessions.ts), while every roster projection HIDES that row
    //      (`threadRoster`, src/server/sessions.ts:4893, mirrored by ../server/api.ts `threadRecordsOf`
    //      :4834). So on today's wire a retired id is NEVER a roster row: the deletion travels beside
    //      the roster, and `sessionThreadsOf` below turns membership into one of these entries.
    //   2. The `inactive` marker ON the row, read structurally below — the shape a roster that
    //      FORWARDS the retired row ships (the raw/export document, a hand-built one, a server whose
    //      roster projection does not filter). Kept because it is a real payload spelling and the
    //      cheapest read of the store's own word when the roster does carry the row.
    // Absent = the server said nothing about this conversation, which is NEVER a deletion signal on its
    // own (see `rosterDeletionsOf` for what is).
    deleted?: boolean;
    // C5: this thread's stored transcript value cannot be read as
    // `HarnessMessage[]`. The record is the raw `SessionSnapshot.invalidThreads`
    // entry (error + the unreadable value verbatim), joined onto the roster so the
    // conversation stays focusable, inspectable and FIXABLE from the normal surfaces.
    // Absent = readable, which is every pre-C5 payload.
    invalid?: InvalidThreadRecord;
};

// One `SessionSnapshot.invalidThreads` entry (C4, additive): the roster's row for a
// conversation whose persisted `messages` value is not a transcript. `messages` is
// the offending value EXACTLY as stored, so the UI can put it in an editor and let
// the reader repair it instead of hiding the conversation.
//
// This is an ALIAS of the server protocol type, not a copy: the shape the client joins
// and the shape the server writes are one declaration, so a new roster field cannot
// appear on the wire and silently miss the UI. The local name stays because the board
// and the transcript dialog (and this module's own `SessionThreadEntry.invalid`)
// already consume it by that name.
export type InvalidThreadRecord = SessionInvalidThread;

const invalidErrorOf = (value: unknown): string =>
    typeof value === 'string' && value.trim().length > 0
        ? value
        : 'the stored transcript could not be read';

// Read the optional invalid roster STRUCTURALLY, like every other snapshot field: a
// server that has no C4 support sends nothing ([] => every existing behaviour is
// byte-identical), and a malformed entry is skipped rather than rendered as a fake
// conversation. An entry with no usable id cannot be joined to anything, so it is
// dropped; ids are deduplicated in server order (first entry wins).
export const invalidThreadsOf = (session: unknown): InvalidThreadRecord[] => {
    if (!isObjectLike(session)) return [];

    const value = session.invalidThreads;
    if (!Array.isArray(value)) return [];

    const records: InvalidThreadRecord[] = [];
    const seen = new Set<string>();

    for (const entry of value) {
        if (!isObjectLike(entry)) continue;

        const id = nonEmptyString(entry.id);
        if (id === undefined || seen.has(id)) continue;
        seen.add(id);

        const label = nonEmptyString(entry.label);
        const agent = nonEmptyString(entry.agent);

        records.push({
            id,
            ...(label === undefined ? {} : { label }),
            ...(agent === undefined ? {} : { agent }),
            error: invalidErrorOf(entry.error),
            messages: entry.messages
        });
    }

    return records;
};

// T-W6/F7 — the session header's RETIRED-CONVERSATION list, read structurally like every other
// document field (the sibling of `invalidThreadsOf` above). Source of truth on the wire:
// `SessionSnapshot.inactiveThreads` / `SessionView.inactiveThreads` (../server/protocol.ts:774/:964)
// and the REST twin `SessionResource.inactive_thread_ids` (../shared/harness-api.ts:1460), which
// ./view-api.ts `sessionViewOf` renames onto the render model.
//
// WHY THE HEADER CARRIES IT AT ALL. The store RETAINS a soft-deleted row (`SessionStore.deleteThread`
// → `markDeletedThread`) and hides it from EVERY roster projection, so a roster that stopped naming an
// id cannot be told apart from a conversation that never existed. This list is therefore the only
// POSITIVE deletion evidence a RELOAD can get, and `sessionThreadsOf` turns membership into the marker
// the board acts on.
//
// Absent (a payload that predates F7), not an array, or empty all answer `[]` — "the server named no
// deletions" — which hides nothing. Only non-empty strings are kept, deduplicated in server order; the
// server sorts by id (../server/sessions.ts `inactiveThreadIdsOf`) and the client never re-sorts.
export const inactiveThreadIdsOf = (session: unknown): string[] => {
    if (!isObjectLike(session)) return [];

    const value = session.inactiveThreads;
    if (!Array.isArray(value)) return [];

    const ids: string[] = [];
    for (const entry of value) {
        const id = nonEmptyString(entry);
        if (id !== undefined && !ids.includes(id)) ids.push(id);
    }

    return ids;
};

// The wire may carry extra fields (`origin`, `references`); the UI ignores them.
// `origin` is deliberately not rendered: the roster this build understands is the
// HOST roster, and an 'agent' default conversation is already represented by its
// turns.
//
// 'paused' MUST stay in this list: it is a real server state (a plugin parked the
// conversation), and dropping it here would silently render a parked thread as `idle`
// through the `?? 'idle'` fallback below.
const THREAD_STATUSES: readonly SessionThreadEntry['status'][] = [
    'idle',
    'running',
    'paused',
    'stopped'
];

const isObjectLike = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const nonEmptyString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value : undefined;

// Read an optional list of opaque ids (the roster's `invocationIds`). Only non-empty
// strings are kept, deduplicated in first-seen (oldest-first) order. An absent or
// malformed value means "the server did not send it" — NEVER "the thread ran no
// invocation": the board must be able to tell the difference, because an empty list
// would be read as authoritative evidence and drop a known join.
const idList = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;

    const ids: string[] = [];
    for (const entry of value) {
        const id = nonEmptyString(entry);
        if (id !== undefined && !ids.includes(id)) ids.push(id);
    }

    return ids.length === 0 ? undefined : ids;
};

// Read the optional roster from a snapshot. Omitted (legacy server) => [] so the
// strip stays hidden and every pre-thread behaviour is byte-identical.
export const sessionThreadsOf = (session: unknown): SessionThreadEntry[] => {
    if (!isObjectLike(session)) return [];

    // T5 R1: the display wire publishes the COMPACT roster (`SessionView.threadViews`,
    // protocol.ts:396-428) and omits `threads`, whose `messages` arrays are the payload class the
    // view contract removes. The raw roster is still read when present (a raw snapshot document
    // from an explicit export, an older server), so one adapter serves both surfaces.
    const compact = Array.isArray(session.threadViews);
    const value = compact ? session.threadViews : session.threads;
    if (!Array.isArray(value)) return [];

    const threads: SessionThreadEntry[] = [];
    const seen = new Set<string>();

    for (const entry of value) {
        if (!isObjectLike(entry)) continue;

        const id = nonEmptyString(entry.id);
        const agent = nonEmptyString(entry.agent);
        if (id === undefined || agent === undefined || seen.has(id)) continue;

        const status = THREAD_STATUSES.find((candidate) => candidate === entry.status) ?? 'idle';
        const sequence = typeof entry.sequence === 'number' && Number.isFinite(entry.sequence)
            ? entry.sequence
            : threads.length + 1;
        // A roster that predates `origin` (or omits it) is a HOST roster: the
        // protocol only serializes host threads. Only an explicit 'agent' is treated
        // as an agent default conversation.
        const origin = entry.origin === 'agent' ? 'agent' : 'host';

        // R3: the historical invocation join, validated like every other roster field
        // (a malformed entry must never break the transcript, and an id repeated by a
        // server bug must not appear twice).
        const invocationIds = idList(entry.invocationIds);

        seen.add(id);
        threads.push({
            id,
            agent,
            origin,
            status,
            sequence,
            ...(nonEmptyString(entry.label) === undefined ? {} : { label: nonEmptyString(entry.label) as string }),
            ...(nonEmptyString(entry.ownerThreadId) === undefined
                ? {}
                : { ownerThreadId: nonEmptyString(entry.ownerThreadId) as string }),
            ...(nonEmptyString(entry.invocationId) === undefined
                ? {}
                : { invocationId: nonEmptyString(entry.invocationId) as string }),
            ...(nonEmptyString(entry.originTurnId) === undefined
                ? {}
                : { originTurnId: nonEmptyString(entry.originTurnId) as string }),
            ...(nonEmptyString(entry.originInvocationId) === undefined
                ? {}
                : { originInvocationId: nonEmptyString(entry.originInvocationId) as string }),
            ...(invocationIds === undefined ? {} : { invocationIds }),
            ...(Array.isArray(entry.messages) ? { messages: [...entry.messages] } : {}),
            // The compact roster's transcript signal (protocol.ts:422-427). Read structurally:
            // a roster that sends neither keeps the pre-T5 behaviour (`messages` decides), and a
            // malformed count is dropped rather than rendered as a fake transcript.
            ...(typeof entry.messageCount === 'number' && Number.isFinite(entry.messageCount)
                ? { messageCount: entry.messageCount }
                : {}),
            ...(typeof entry.hasTranscript === 'boolean' ? { hasTranscript: entry.hasTranscript } : {}),
            ...(nonEmptyString(entry.preview) === undefined ? {} : { preview: nonEmptyString(entry.preview) as string }),
            // F7 (T-W3, restated by T-W6): the ROW-level half of the soft-delete verdict. Read only
            // when the wire SAYS it — an absent or malformed `inactive` is "the server did not report a
            // deletion", which is not the same fact as `inactive: false` and must not hide a row.
            //
            // Kept deliberately, and NOT the live path: today every roster projection filters the marked
            // row out (src/server/sessions.ts `threadRoster` :4893, ../server/api.ts `threadRecordsOf`
            // :4834), so on a current server the deletion arrives as MEMBERSHIP in the header's retired
            // list instead (joined below, and the reason the positive ledger path works on a reload).
            // This read stays because `sessionThreadsOf` also serves documents that FORWARD the retired
            // row — the raw roster of an export read, an embedder's or a test's hand-built snapshot, a
            // server whose roster projection does not filter — and there the marker on the row is the
            // store's own word with no header list beside it. Both spellings land in the ONE field the
            // board consumes (`deleted`), so the ledger stays a single membership check.
            ...(entry.inactive === true ? { deleted: true } : {})
        });
    }

    // C5: join the invalid-transcript roster. The server either keeps the thread's
    // `threads[]` row and ALSO names it in `invalidThreads` (its `messages` cannot be
    // typed as `HarnessMessage[]`), or reports the conversation ONLY there. Both
    // shapes must reach the same surfaces, so the record is stamped onto a matching
    // entry and synthesized for one the roster lost. A conversation the reader cannot
    // see cannot be repaired, which is the whole point of the editable transcript.
    //
    // A synthesized entry is a HONEST PARTIAL: no status/origin is knowable from the
    // invalid record, so it reads as an idle host conversation and the server stays
    // the authority for what is actually running (a 409 on delete/steer is possible
    // and handled by the existing paths).
    const invalidRecords = invalidThreadsOf(session);
    for (const record of invalidRecords) {
        const existing = threads.find((entry) => entry.id === record.id);
        if (existing !== undefined) {
            existing.invalid = record;
            continue;
        }

        threads.push({
            id: record.id,
            agent: record.agent ?? '',
            origin: 'host',
            status: 'idle',
            sequence: threads.length + 1,
            ...(record.label === undefined ? {} : { label: record.label }),
            invalid: record
        });
    }

    // T-W6/F7 — join the header's RETIRED-CONVERSATION list (see `inactiveThreadIdsOf` for the wire
    // field and why the deletion cannot ride the roster). Membership is POSITIVE evidence of deletion:
    // no baseline comparison, no previous roster, no ordering assumptions — which is exactly what a
    // RELOAD needs, because that board never watched the delete happen.
    //
    // THE PRECEDENCE, stated once (and it is the revival rule):
    //   1. A row the ROSTER NAMES keeps whatever verdict ITS OWN row carries. A resume clears the
    //      store's ledger key AND the row marker in the same call (`reactivateThreadRow`,
    //      src/server/sessions.ts:5140-5163), so a roster row is the server's NEWER word and the
    //      retired list is only the retention ledger it has not caught up with yet. Marking such a row
    //      deleted here would hide a resumed conversation forever: `revivedThreadIdsOf` retracts an id
    //      the roster names WITHOUT the marker, and a stamp added here is indistinguishable from one
    //      the row itself brought.
    //   2. An id NOTHING on the roster names gets a synthesized entry (`seen` is the roster's own id
    //      set from the loop above, so an entry built from the C5 invalid roster is not a roster row
    //      and does get the stamp). It is a HONEST PARTIAL like the C5 entry: an agent, a status, a
    //      label and invocation ids are not knowable from a bare id, and nothing needs them — the
    //      entry exists only to carry the marker into `deletedThreadIdsOf`, while the row it hides
    //      comes from the compiled display tree, which names the thread itself
    //      (ui/turns.ts `paintCompiledSection` → `learnedThreads`). Its label is the explicit unknown
    //      token, so a retired id consumes NO per-agent ordinal and cannot renumber a live
    //      conversation's name.
    const retiredIds = inactiveThreadIdsOf(session);
    for (const id of retiredIds) {
        const existing = threads.find((entry) => entry.id === id);

        if (existing === undefined) {
            threads.push({
                id,
                agent: '',
                origin: 'host',
                status: 'idle',
                sequence: threads.length + 1,
                // `UNKNOWN_THREAD_LABEL` is this module's declared token for "identity not known"
                // (declared below; this runs after module init, so the const is already bound).
                label: UNKNOWN_THREAD_LABEL,
                deleted: true
            });
            continue;
        }

        if (seen.has(id) || existing.deleted === true) continue;
        existing.deleted = true;
    }

    // Creation order is the server's `sequence`, not the array order: a restored or
    // re-serialized roster must not reshuffle the strip. Ties keep input order.
    const ordered = threads.sort((left, right) => left.sequence - right.sequence);

    // R8 legacy fallback: a pre-R8 roster carries no `label`. Derive the SAME
    // agent-prefixed shape (`RR1`, `RR2`, … per agent) from roster order, so the
    // generic global `T<sequence>` name never appears. A server label always wins.
    const ordinals = new Map<string, number>();
    return ordered.map((entry) => {
        if (entry.label !== undefined) return entry;

        const code = agentCodeOf(entry.agent);
        const ordinal = (ordinals.get(code) ?? 0) + 1;
        ordinals.set(code, ordinal);
        return { ...entry, label: `${code}${ordinal}` };
    });
};

// T-W3 + T-W6/F7 — WHICH CONVERSATIONS THE ROSTER REPORTS AS GONE.
//
// WHY A PAIR OF ROSTERS, NOT ONE. A roster alone cannot answer "gone": it would read "never existed"
// and "deleted" the same way. So the board compares the roster it is replacing with the one it is
// installing, and the sync is PURE, so the board's DOM pass and a test ask the identical question.
//
// THE ROSTER THIS BUILD GETS ALREADY CARRIES THE ANSWER. `sessionThreadsOf` above joins the session
// header's retired list onto the roster as `SessionThreadEntry.deleted`, so the evidence below is drawn
// from ONE input the shell hands the board — and the ledger functions stay the single place the verdict
// is computed.
//
// Evidence, in order:
//   1. POSITIVE — membership in the session header's retired list
//      (`SessionView.inactiveThreads`, ../server/protocol.ts:964, forwarded from
//      `SessionResource.inactive_thread_ids` by ./view-api.ts `sessionViewOf`). THE LIVE PATH, and the
//      one that works on a RELOAD: the store RETAINS a soft-deleted row and every roster projection
//      hides it (`threadRoster`, src/server/sessions.ts:4893, ../server/api.ts:4834), so an id named
//      there is deleted even on a FIRST roster — no baseline, no previous frame, no comparison.
//   2. POSITIVE — a row the roster itself still ships and stamps `inactive`
//      (`SessionStore.deleteThread` → `markDeletedThread` writes the marker; a roster that FORWARDS the
//      retired row — the raw/export document, a hand-built one — states the same fact this way).
//   3. REMOVAL — an id a NON-EMPTY roster named and the next one no longer names. A non-empty roster
//      enumerates every live HOST conversation, so an id it drops was deleted — the same evidence the
//      board already accepts for its invocation→thread join cache (ui/turns.ts `forgetRemovedThreads`).
//      With (1) in place this is the FALLBACK, not the only path: it still carries a deletion on a
//      payload whose server has no retired list at all, and it re-asserts the same verdict when a later
//      document happens to omit the list (a roster-only frame cannot make the conversation reappear).
//
// What is deliberately NOT evidence: absence from an EMPTY roster (a payload without the list, or a
// first bind — the board legitimately renders placeholder rows for a conversation it was never told
// about, see ui/turns.ts `T?` and the projector's `adoptPlaceholder` sections), and a conversation the
// next roster names again WITHOUT a marker — a resume puts the row back and clears the retired list in
// the same store call (`reactivateThreadRow`, src/server/sessions.ts:5140-5163), so the verdict is
// re-derived from the newest roster, never remembered past the server's word.
const rosterIdsOf = (entries: readonly SessionThreadEntry[]): Set<string> =>
    new Set(entries.map((entry) => entry.id));

/**
 * The ids this roster reports as deleted, in roster order: an entry carrying the server's soft-delete
 * marker. Both wire spellings end up as one of these entries (`sessionThreadsOf` turns MEMBERSHIP in
 * the header's retired list into an entry marked `deleted`, and forwards a row that stamps `inactive`
 * itself), so the board never has to know which one it is looking at.
 */
export const deletedThreadIdsOf = (entries: readonly SessionThreadEntry[]): string[] =>
    entries.filter((entry) => entry.deleted === true).map((entry) => entry.id);

/**
 * The conversations the NEW roster reports gone, given the roster the board is replacing (`previous`).
 * Ids only — the board owns what that means for its rows, and it ACCUMULATES this answer: the server's
 * roster filter reports a deletion on one frame and merely omits the id afterwards, and a header list
 * keeps naming it for as long as the row is retained.
 *
 * The POSITIVE evidence (a marked entry, whatever put the mark there) is collected BEFORE the
 * `next.length > 0` gate on purpose, so it holds on a FIRST roster — that is the reload case. Only the
 * REMOVAL join needs a previous roster to compare against.
 */
export const rosterDeletionsOf = (
    previous: readonly SessionThreadEntry[],
    next: readonly SessionThreadEntry[]
): string[] => {
    const removed = new Set(deletedThreadIdsOf(next));

    if (next.length > 0) {
        const named = rosterIdsOf(next);

        for (const id of rosterIdsOf(previous)) {
            if (!named.has(id)) removed.add(id);
        }

        // A conversation the new roster names WITHOUT the marker is live: a delete that was undone (or
        // a resume) retracts a verdict this frame just drew. This is also the guard that keeps the
        // removal join from outliving the server's word — an id the roster ships live again is on
        // `named` AND off the marker list, so whatever this frame concluded about it is dropped.
        for (const entry of next) {
            if (entry.deleted !== true) removed.delete(entry.id);
        }
    }

    return [...removed];
};

/**
 * Of the ids the board already concluded were deleted, the ones the NEW roster names again as LIVE. A
 * resumed conversation is addressable again, so its rows come back — the ledger is re-derived from the
 * roster, never remembered past the server's word.
 *
 * This is the REVIVAL half of the retired-list join: the store clears the ledger key and the row marker
 * when a host resumes a conversation (src/server/sessions.ts `reactivateThreadRow`), so the next
 * document both NAMES the row in the roster and stops marking it, and `sessionThreadsOf` stamps nothing.
 * An id the retired list still names while the roster ships it live is the same case one frame early
 * (the roster wins, `sessionThreadsOf` rule 1) and revives here too.
 */
export const revivedThreadIdsOf = (
    entries: readonly SessionThreadEntry[],
    known: ReadonlySet<string>
): string[] => entries.filter((entry) => entry.deleted !== true && known.has(entry.id)).map((entry) => entry.id);

// Read one turn's PERSISTENT thread id structurally. `SessionTurn.threadId` is
// additive: a pre-thread record (and every legacy fixture) omits it, which means
// "no persistent identity known" — NOT "a new thread on every read".
export const turnThreadIdOf = (turn: unknown): string | undefined => {
    if (!isObjectLike(turn)) return undefined;

    return nonEmptyString(turn.threadId);
};

// Display name of a roster entry: the server conversation label when it has one,
// otherwise an agent-prefixed fallback derived from the entry itself. There is
// deliberately NO `T<sequence>` fallback: that generic wrapper is exactly the
// duplicate identity R8 removes. A hand-built entry with no agent at all reads
// the explicit unknown token.
export const threadNameOf = (entry: Pick<SessionThreadEntry, 'agent' | 'sequence' | 'label'>): string => {
    if (entry.label !== undefined && entry.label.trim().length > 0) return entry.label;

    const agent = nonEmptyString(entry.agent);
    return agent === undefined ? UNKNOWN_THREAD_LABEL : `${agentCodeOf(agent)}${entry.sequence}`;
};

// CANONICAL display identity of a persistent thread (S6).
//
// One function for the strip row AND the transcript tile badge, so the same
// conversation can never read as `Research` in one place and `T3` in another. The
// roster's label/sequence is authoritative; ids are opaque and are NEVER parsed for
// digits (an id with no trailing number would otherwise collide with an unrelated
// one). A thread the roster does not describe yet shows the explicit unknown token
// `T?`; its full id stays in `data-thread-id`/`title`.
export const UNKNOWN_THREAD_LABEL = 'T?';

export const threadLabelOf = (
    threadId: string | undefined,
    threads: readonly SessionThreadEntry[]
): string | undefined => {
    if (threadId === undefined || threadId.length === 0) return undefined;

    const entry = threads.find((candidate) => candidate.id === threadId);

    return entry === undefined ? UNKNOWN_THREAD_LABEL : threadNameOf(entry);
};

// Hover/accessible detail for a tile badge. Includes the AGENT (S6: two threads of
// the same agent must be distinguishable) plus the full opaque id.
export const threadTitleOf = (
    threadId: string | undefined,
    threads: readonly SessionThreadEntry[]
): string | undefined => {
    if (threadId === undefined || threadId.length === 0) return undefined;

    const entry = threads.find((candidate) => candidate.id === threadId);
    if (entry === undefined) return `Thread ${threadId}`;

    return `Thread ${threadNameOf(entry)} · ${entry.agent} · ${entry.status}`;
};

// --- submit routing (R5/R6): one decision, shared by the composer label and the
// --- POST body ---------------------------------------------------------------
//
// `new`       no focused thread and no references: a standalone thread.
// `connected` no focused thread but the draft carries `#` references: a NEW thread
//             that is connected to the referenced conversations. The connection is
//             the `references` array itself (the server expands those blocks into
//             the run prompt after they complete); there is no extra wire field.
// `continue`  a focused thread that is idle/stopped: the next turn runs in the SAME
//             persistent conversation (the server starts a new run in it).
// `steer`     a focused thread that is RUNNING: the text is appended to that thread
//             as a steering user message at the next safe model boundary. The
//             server may answer with the OWNING turn instead of a new one, so the
//             submit path must reconcile a same-id record (main.ts `run`).
//
// `mode` is only the ROUTING decision (which thread the body addresses); it is not
// a promise about how the server executes it. A running focus is `steer` even when
// the submit cannot be steered: the server's steering API is text-only and skips
// references whose target is not terminal yet, so an attachment-bearing or
// unfinished-reference submit to a running thread becomes a QUEUED CONTINUATION
// turn in that same thread (sessions.ts enqueue → steerIntoThread). The `queued`
// flag below carries that qualifier, so the composer label never promises an
// immediate fold-in it cannot keep while `threadId` stays the same.
export type SubmitTargetMode = 'new' | 'connected' | 'continue' | 'steer';

export type SubmitTarget = {
    mode: SubmitTargetMode;
    // Present for `continue`/`steer` only. Absent is the wire's "new thread" signal.
    threadId?: string;
    // Display name for the composer's target line (never sent to the server).
    name?: string;
    // True when a RUNNING focus will receive a QUEUED CONTINUATION instead of an
    // immediate steer (attachments present, or a referenced result is unfinished).
    // Display-only: the wire body is identical, so targeting semantics are
    // untouched. See resolveSubmitTarget.
    queued?: boolean;
};

// Decide where the next submit goes.
//
// The FOCUS is authoritative on its own: a focused thread id missing from a
// (legacy or partial) roster is still continued, because the id came from a turn
// record this session actually produced. Only a deleted thread loses focus, and
// that happens in the board/turn reconcile (its tile disappears => no expanded
// turn => no focus), never here.
//
// `references` is the count of `#` bindings in the draft (see ui/references.ts);
// it changes only the UNFOCUSED case, where it turns a standalone thread into a
// connected one.
//
// `attachments` and `unfinishedReferences` refine the FOCUSED-running case only.
// Both mirror what the server will do with a running target: attachments are never
// steered (text-only API) and a reference to a block that has not settled cannot
// be expanded into steering text, so either one turns the submit into a queued
// continuation. The id (and therefore the body) is unchanged either way; only the
// label becomes honest.
export const resolveSubmitTarget = (options: {
    focus?: string;
    threads?: readonly SessionThreadEntry[];
    references?: number;
    // Number of READY attachments in the draft (still-encoding files do not count:
    // they cannot be submitted).
    attachments?: number;
    // Number of `#` references whose referenced turn is still queued/running, i.e.
    // its result block does not exist yet. Callers that cannot know a status omit
    // this (0), which keeps the plain "Steering" label.
    unfinishedReferences?: number;
}): SubmitTarget => {
    const focus = nonEmptyString(options.focus);

    if (focus !== undefined) {
        const entry = (options.threads ?? []).find((candidate) => candidate.id === focus);
        // An unknown status (no roster entry yet) is treated as continue: a running
        // target steers server-side anyway, so the POST body is identical either way.
        const running = entry?.status === 'running';

        // A running target that cannot be steered is still addressed to the same
        // thread — the server queues a continuation turn there — so `mode` and
        // `threadId` stay `steer`+id and only the display qualifier changes.
        const queued =
            running &&
            ((options.attachments ?? 0) > 0 || (options.unfinishedReferences ?? 0) > 0);

        return {
            mode: running ? 'steer' : 'continue',
            threadId: focus,
            ...(entry === undefined ? {} : { name: threadNameOf(entry) }),
            ...(queued ? { queued: true } : {})
        };
    }

    return (options.references ?? 0) > 0 ? { mode: 'connected' } : { mode: 'new' };
};

// One-line description of a routing decision for the composer's target line. The
// reader must be able to see, before pressing send, that the message will steer the
// focused thread rather than open a new one.
//
// A `queued` steer says "Queued in" instead: the text and bytes are accepted into
// that thread but run as a continuation turn once the active one finishes, so
// "Steering" would promise an immediate fold-in the server will not perform
// (attachments, or a referenced result that is not terminal yet).
export const submitTargetLabel = (target: SubmitTarget): string => {
    const name = target.name ?? 'thread';

    if (target.mode === 'steer') return target.queued === true ? `Queued in ${name}` : `Steering ${name}`;
    if (target.mode === 'continue') return `Continuing ${name}`;
    if (target.mode === 'connected') return 'New connected thread';

    return 'New thread';
};

// --- display labels (R8) -----------------------------------------------------
//
// A conversation's visible name is its server-allocated agent-prefixed label
// (`RR1`, `RR2`, …, `IT1`). It belongs to the PERSISTENT thread: every turn, run
// and continuation repeats it, and only a new conversation consumes the next
// ordinal. A legacy roster entry without a label derives the SAME shape from its
// per-agent order (never the global creation ordinal `T8`).

// Read one turn's recorded conversation label structurally (additive protocol
// field). Undefined for a legacy/pre-R8 turn; callers then use the roster name.
export const turnThreadLabelOf = (turn: unknown): string | undefined => {
    if (!isObjectLike(turn)) return undefined;

    return nonEmptyString(turn.threadLabel);
};

export { agentCodeOf };

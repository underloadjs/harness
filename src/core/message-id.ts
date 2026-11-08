// Stable message ids (context-inclusion follow-ups, T1).
//
// WHY THIS EXISTS
// ---------------
// A `turn.before` handler could previously address a transcript entry in exactly two
// ways: by its INDEX in the list it was handed, or by the live message OBJECT
// (src/harness.ts `indexOfIssuedEntry` resolves `canonical.indexOf(target.message)`).
// Both are round-scoped: a numeric index is re-read against the CURRENT transcript, and
// `replaceHistory()` replaces the message identities, so neither survives a rewrite of
// the list, a restart, or a hand-off to another turn. This module adds the third,
// durable address: a `messageId` string that rides on the canonical message itself, is
// carried by every persistence path, and therefore names the SAME turn in the next round
// of the same conversation.
//
// It is an ADDITIONAL target, never a replacement — index and object-identity
// resolution stay exactly as shipped (src/harness.ts `resolveUnit`), because they are
// already tested behaviour and removing them is a breaking change to a shipped surface.
//
// THE SHAPE: `msg-<n>`, one number per transcript
// ------------------------------------------------
// There is deliberately NO process-wide counter. The id of a message is derived from
// the transcript it lives in — one above the highest numeric id already in that list —
// which is what makes ids reproducible in tests (a fresh conversation always starts at
// `msg-1`) while staying collision-free WITHOUT any shared state that restore, fork,
// lane-append and worker processes would each have to keep in step. Reserve-from-max is
// the same trick src/harness.ts already uses for branch ids (`reserveBranchSequence`).
//
// Consequences, stated rather than discovered:
//   - a mint is a scan of the transcript it appends to (O(n) once per NEW message —
//     the same order as the `resultInsertIndex` scan a tool result already pays);
//   - a host-authored id that does not spell `msg-<n>` is OPAQUE: it is carried
//     verbatim (copy, never re-mint) and ignored by the max scan, and minting skips any
//     candidate that is already present verbatim, so a hand-written transcript can never
//     be given an id it already uses;
//   - ids are unique WITHIN one transcript. Across conversations they repeat by design
//     (T1.4: a fork COPIES ids, so the fork's copy and the owner's entry are two objects
//     with one identity), and every lookup here is scoped to one agent's transcript.
//
// WHAT NEVER MINTS: a COPY. `withIncluded` (core/agent.ts) produces a REQUEST-SAFE copy
// — no `included`, no `messageId` — so a projection can never masquerade as transcript
// state, and every canonical creation point decides explicitly between minting a fresh
// id (`assignMessageId` with no `copiedId`) and carrying the source's (`copiedId` set:
// fork baseline, snapshot restore, branch copy). Re-minting on a copy is the failure
// mode this rule exists to prevent: the id would stop being an identity.
//
// Cross-references:
//   - ../types/index.ts         — `HarnessMessage.messageId`, `HarnessContextEntry.messageId`
//   - ./agent.ts                — the canonical creation points (seed, appends, commit)
//   - ./snapshot.ts             — the persisted allowlists + backfill-on-read
//   - ./branch.ts               — fork/branch copies (ids are carried, never re-minted)
//   - ../harness.ts             — `insertToolMessage`, `transcriptUnits`, `setIncluded`

import type { HarnessMessage } from '../types';

// The runtime's own id spelling. A host may put any non-empty string in the key; this
// prefix is what the minting sequence understands (see the header).
export const MESSAGE_ID_PREFIX = 'msg-';

// One sequence number as a canonical id string.
export const formatMessageId = (sequence: number): string => `${MESSAGE_ID_PREFIX}${String(sequence)}`;

// The numeric part of a `msg-<n>` id, or 0 when the value is absent, not a string, or
// not in that spelling (an opaque host id). 0 means "contributes nothing to the max",
// which is why the runtime's ids start at 1.
export const messageIdSequenceOf = (id: unknown): number => {
    if (typeof id !== 'string' || !id.startsWith(MESSAGE_ID_PREFIX)) return 0;

    const body = id.slice(MESSAGE_ID_PREFIX.length);
    if (!/^[1-9][0-9]*$/.test(body)) return 0;

    const sequence = Number(body);
    return Number.isSafeInteger(sequence) ? sequence : 0;
};

// Reads the id off a canonical message OR a raw JSON message record (the snapshot
// reader and the runtime mint against the same values, so both go through here).
// A non-string or empty-string value reads as ABSENT: it is carried verbatim by the
// reader but never counted, so it cannot make the mint hand out a colliding id.
export const messageIdOf = (record: unknown): string | undefined => {
    if (typeof record !== 'object' || record === null) return undefined;

    const value = (record as { messageId?: unknown }).messageId;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
};

// The id for ONE message that is about to enter `transcript`: one above the highest
// numeric id it already carries, skipping anything present verbatim.
export const nextMessageIdOf = (transcript: readonly unknown[]): string => {
    const taken = new Set<string>();
    let sequence = 0;

    for (const message of transcript) {
        const id = messageIdOf(message);
        if (id === undefined) continue;

        taken.add(id);
        const sequenceOfId = messageIdSequenceOf(id);
        if (sequenceOfId > sequence) sequence = sequenceOfId;
    }

    let next = sequence + 1;
    while (taken.has(formatMessageId(next))) next += 1;

    return formatMessageId(next);
};

// Batch minting for the snapshot reader (core/snapshot.ts), which walks a whole
// transcript and must not pay a fresh scan per message. It answers, per entry, the id
// that entry should carry: its OWN when it already has one (a copy keeps its identity),
// otherwise the next free id — so a pre-id `state.json` restores with ids, and
// `restore -> snapshot` hands the same document back unchanged (idempotent, the same
// property `applyIncluded` upholds for the flag).
export const createMessageIdAllocator = (
    transcript: readonly unknown[]
): (presentId: string | undefined) => string => {
    const taken = new Set<string>();
    let sequence = 0;

    for (const message of transcript) {
        const id = messageIdOf(message);
        if (id === undefined) continue;

        taken.add(id);
        const sequenceOfId = messageIdSequenceOf(id);
        if (sequenceOfId > sequence) sequence = sequenceOfId;
    }

    return (presentId: string | undefined): string => {
        if (presentId !== undefined) {
            // Copy, never re-mint. A well-formed copied id still moves the ceiling, so
            // a later backfill cannot collide with an id that appears further along.
            const sequenceOfId = messageIdSequenceOf(presentId);
            if (sequenceOfId > sequence) sequence = sequenceOfId;

            return presentId;
        }

        let next = sequence + 1;
        while (taken.has(formatMessageId(next))) next += 1;

        sequence = next;
        taken.add(formatMessageId(next));

        return formatMessageId(next);
    };
};

// Attach the id to a canonical message as it is created.
//
//   - `copiedId` SET  — this message is a COPY of one that already had an id (a fork
//     baseline, a branch record): the id is carried verbatim. That is the T1.4 policy,
//     and it is why `setIncluded(id)` on a fork round names the same turn as on its
//     owner.
//   - `copiedId` ABSENT — a genuinely new message: mint the next id for `transcript`,
//     the array this message is about to enter.
//
// The key is written LAST, so a message keeps the historical key order its role had
// before ids existed (`role`, `content`, role fields, flag, then `messageId`). The
// input object is not mutated; the result is a new object, which is what every caller
// here already does anyway (they build the message inline).
export const assignMessageId = (
    message: HarnessMessage,
    transcript: readonly HarnessMessage[],
    copiedId?: string
): HarnessMessage => ({
    ...message,
    messageId:
        typeof copiedId === 'string' && copiedId.length > 0
            ? copiedId
            : nextMessageIdOf(transcript)
});

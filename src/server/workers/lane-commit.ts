// Lane commits: shared state is MUTATED AT THE AUTHORITY, under explicit receipts.
//
// WHY THE REPLICA MERGE WAS RETIRED (T3 findings F1-F8)
// ----------------------------------------------------
// The first design let a lane mutate a full harness replica and folded the record
// diff back into the canonical state with a last-writer-wins merge. The review
// proved that model loses real work: two replicas minted the same `invocationId`
// and one terminal result vanished; two lanes editing one record overwrote each
// other silently; a lane's untouched sibling memory key got DELETED because the
// replica's diff base moved without its live map moving; an unowned mutation was
// dropped without a word; and the merged `nextId`/`createdToolCount` produced a
// snapshot the core's own validator rejected.
//
// This module therefore states the opposite contract, and it is the semantics the
// live applier must satisfy:
//
//   - a lane sends an OPERATION, never a state document;
//   - the authority mints every id it can (`record:add`, `thread:create`, result
//     ordering, created-tool budget) so no two writers can collide (F1/F2);
//   - a mutation that rewrites an existing record carries the DIGEST of the value it
//     replaced; the authority compares it against the CANONICAL value and refuses a
//     stale one. Concurrent edits therefore serialise by receipt - no lost update,
//     and no weak "these two values are just different" conflict flag (F5/F12);
//   - a transcript is APPENDED at a known prefix length, so a lane cannot overwrite text a
//     sibling appended into the same conversation;
//   - and the ALREADY-COMMITTED prefix may be rewritten IN PLACE only by the lane holding the
//     digest of that prefix (`transcript:patch`, pipeline T4.1). That is what makes a plugin's
//     `setIncluded`/`edit` durable under `threadExecution: 'worker'`: the write is canonical and
//     notified on the authority, so `state.json` captures it, while a concurrent rewrite of the
//     same prefix is a refusal with the canonical facts in the receipt — never a silent overwrite.
//   - one WRITER LEASE per shared conversation: a second lane delegating to the same
//     agent's default conversation is refused and takes its own child conversation
//     instead of writing behind the first lane's back (F5);
//   - anything a lane mutated that it does not own is REJECTED with a reason, never
//     filtered out quietly (F6);
//   - a receipt, not the send, is what advances a lane's notion of committed state;
//     a rejected receipt advances nothing and forbids reporting the turn as a
//     success (F7/F8);
//   - every kind is checked against the core's own bounds BEFORE applying, and one
//     mutation is applied atomically (all-or-nothing), because half a `record:add`
//     inside a live canonical store is not recoverable (F10).
//
// WHAT THIS MODULE IS NOT
// -----------------------
// It is the executable SEMANTIC REFERENCE for the fold, over a plain canonical view.
// The session layer maps each kind onto ONE targeted harness operation (append this
// thread, insert this record, register this tool) - never a wholesale `restore()` per
// commit, which rebuilds tools and thread agents and zeroes the run generation. A
// test of the live applier must reproduce every case below.
//
// Cross-references:
//   - ./lane-identity.ts  - the id spaces and leases this module consumes
//   - ./lane-memory.ts    - the digest/CAS rules for `harness.memory`
//   - ./protocol.ts       - the `mutation` / `receipt` / `broadcast` frames
//   - ../sessions.ts      - the coordinator that owns the canonical harness
//   - ../../core/thread.ts - MAX_THREAD_RECORDS (256)
//   - ../../core/agent-limits.ts - AGENT_RESULT_RETENTION (64)
//   - ../../core/creation.ts - DEFAULT_CREATED_TOOLS_LIMIT (32)

import { AGENT_RESULT_RETENTION, DEFAULT_CREATED_TOOLS_LIMIT, MAX_THREAD_RECORDS } from '../../core';
// The snapshot readers' value bounds (../../core/snapshot-validation.ts), reused verbatim by
// `readArchiveForensicPair` below so the lane archive fold and the core's canonical write refuse the
// same malformed FORENSIC PAIR (review finding #5 / issues 0020 + 0033). Direct module import, the
// same convention src/harness.ts uses for these two helpers: the core barrel does not re-export them.
import { readSnapshotInteger, readSnapshotString } from '../../core/snapshot-validation';
import type { HarnessAgentResultSnapshot, HarnessMessage } from '../../types';
import type { IdentityLedger } from './lane-identity';
import { idOf } from './lane-identity';
import { ABSENT_DIGEST, applyMemoryWrite, digestMemoryValue } from './lane-memory';

// The collection keys of the ONE session store (records-engine T3): the snapshot no
// longer holds four sibling stores, so a fold names a COLLECTION, and the id counter
// every collection draws from is the store-level `view.records.nextId`, not a per-store
// number.
export const RECORD_STORES = ['tasks', 'chapters', 'profiles', 'locations'] as const;
export type RecordStoreName = (typeof RECORD_STORES)[number];

export const MAX_RECORDS_PER_STORE = 512;
export const MAX_MESSAGES_PER_THREAD = 20_000;
export const MUTATION_GROUP_LIMIT = 64;

// ---------------------------------------------------------------------------
// Canonical view (the shape the authority holds; the live applier maps each field
// onto the corresponding harness state, and `harness.snapshot()` seeds it)
// ---------------------------------------------------------------------------

export type CanonicalThread = {
    id: string;
    agent: string;
    // R2/R3 ripple: 'paused' is a runtime status a plugin owns (types/index.ts
    // `HarnessThreadStatus`), so the canonical view must be able to HOLD it or a lane
    // fold would drop the transition. A snapshot still never carries it — snapshot()
    // maps a parked thread to 'idle' — so this widens the shape, not the persisted set.
    status: 'idle' | 'running' | 'paused' | 'stopped';
    sequence: number;
    label?: string;
    ownerThreadId?: string;
    messages: HarnessMessage[];
};

export type CanonicalRecord = { id: string } & Record<string, unknown>;

// One collection's records. `nextId` is kept as a MIRROR of the store-level counter
// (`CanonicalView.records.nextId`, the one that is authoritative since F3 collapsed the
// four id spaces into one); a fold that mints an id updates both, so a caller reading
// either number sees the same fact.
export type CanonicalStore = { items: CanonicalRecord[]; nextId: number };

export type CanonicalTool = { name: string; source: string; revision: string; replaced: boolean };

// The digest of an archived invocation, over ONLY the fields a writer owns.
//
// Why not `digestMemoryValue(record)`: the authority reassigns `completedOrder` when it
// applies an archive (ordering is decided where the ordering counter lives), so a lane
// comparing its own record against a canonical digest would never match and would
// re-archive forever. Both sides therefore digest the SAME projection.
//
// Review finding #5 / issues 0020 + 0033 (2026-11-14): the FORENSIC PAIR is now part of that
// projection, and the reason it has to be is the skip test the digest is guarding. A lane whose
// archive op is rejected with a digest that DIFFERS from its own re-derives the archive and tries
// again, which is what keeps a lost write recoverable; a lane whose digest MATCHES treats the row as
// already archived and skips — `./lane-worker-loop.ts` `deriveOperations` emits an archive op only
// when `lane.archived` disagrees with `archiveDigestOf(record)`. Before this, a cancelled lane child
// carried no pair across the seam on either side, so the digests agreed while canonical held
// `partialContent` absent — and for a worker-mode cancellation that had ALREADY archived an empty
// row, the writer skipped the very op that would have carried the pair: the digest was suppressing an
// op whose payload mattered. Once the pair is in the payload, leaving it out of the digest would keep
// that trap: canonical state moving from no-pair to pair would be invisible to the equality test that
// decides whether to send it.
//
// The asymmetry with the two EXCLUDED fields is deliberate and stays. `completedOrder` is excluded
// because the authority RE-MINTS it (a writer cannot know it in advance, so including it would break
// the very agreement above and cause endless re-archiving). `threadId` is excluded because it is
// conversation metadata the authority stores, not part of the answer the writer produced — and the
// field was added to the op after the fact, so an archive op from an older send (which names no
// conversation, `SharedMutation`'s own comment above) must still digest equal to a canonical row that
// carries one, or every such lane re-archives its whole history forever. The pair is the opposite
// case on both counts: the lane's replica PRODUCES both values (its `finishInvocation` wrote them),
// they are the answer's content, and the authority stores them verbatim — src/harness.ts drops them
// on `completed` and the fold in this file drops them the same way, so both sides project the same
// keys and the digests stay equal.
export const archiveDigestOf = (record: {
    invocationId: string;
    sequence: number;
    agent: string;
    role: string;
    kind: string;
    status: string;
    content?: string;
    error?: string;
    partialContent?: string;
    cancelledAtMessage?: number;
}): string =>
    digestMemoryValue({
        invocationId: record.invocationId,
        sequence: record.sequence,
        agent: record.agent,
        role: record.role,
        kind: record.kind,
        status: record.status,
        content: record.content ?? '',
        ...(record.error === undefined ? {} : { error: record.error }),
        // Absent-vs-present is load-bearing, so the projection mirrors the record instead of
        // defaulting: a record whose partial was dropped (completed) must digest exactly like the
        // record the authority stored, key for key.
        ...(record.partialContent === undefined ? {} : { partialContent: record.partialContent }),
        ...(record.cancelledAtMessage === undefined ? {} : { cancelledAtMessage: record.cancelledAtMessage })
    });

// The FORENSIC PAIR of an archive payload: validated, and projected onto what a row may store
// (review finding #5 / issues 0020 + 0033, 2026-11-14).
//
// Why this is a shared helper rather than two inline reads: the rule runs on BOTH seams — this fold
// (./lane-authority.ts replays the same group through it) and the live canonical write
// (src/harness.ts `archiveInvocation`) — and the two must accept EXACTLY the same payloads. A value
// this fold rejects while the core accepts is a receipt that says `invalid-mutation` about state that
// landed; a value the fold accepts while the core rejects rolls the whole group back after the fold
// already moved the view. Both sides therefore call the same bounds, and the bounds are
// `../../core/snapshot-validation.ts` — the module ../core/snapshot.ts itself uses to read these two
// fields back off disk — reused rather than re-derived, so a payload can never be legal to archive
// and illegal to reload.
//
// The rules, in one place:
//   * an ABSENT field stays absent: a lane built against the previous payload archives the row it
//     always archived, and a `completed` row carries neither field;
//   * a PRESENT value must be well-formed — a string of at least one character, a safe integer >= 0.
//     Nothing is coerced: issue 0020 lists coercion as a defect, because silently repairing a
//     forensic field is how it stops being evidence of what actually happened;
//   * a present-but-blank partial is refused for the same reason: "present" is the signal that the
//     run said something, and whitespace says nothing;
//   * a `completed` status DROPS both fields. That is not leniency, it is loadability —
//     ../core/snapshot.ts:280-300 refuses to read a completed row that carries the pair, so a fold
//     that kept it would write a canonical view (and a next snapshot) that cannot be reloaded.
//     A cancelled row that later COMPLETES is the ordinary case: the replacement payload has no pair
//     of its own, and the drop is what stops the earlier cancellation's evidence outliving it.
//
// A throw here is a PERMANENT refusal, so callers map it to `invalid-mutation` (not the op kind's
// usual conflict): a malformed payload re-derived forever would never converge.
const readArchiveForensicPair = (mutation: {
    invocationId: string;
    status: string;
    partialContent?: string;
    cancelledAtMessage?: number;
}): { partialContent?: string; cancelledAtMessage?: number } => {
    const partialContent =
        mutation.partialContent === undefined
            ? undefined
            : readSnapshotString(mutation.partialContent, `Invocation "${mutation.invocationId}".partialContent`, {
                  min: 1,
              });

    if (partialContent !== undefined && partialContent.trim().length === 0) {
        throw new Error(
            `Invocation "${mutation.invocationId}".partialContent cannot be blank; a run that said nothing archives no partial at all.`
        );
    }

    const cancelledAtMessage =
        mutation.cancelledAtMessage === undefined
            ? undefined
            : readSnapshotInteger(mutation.cancelledAtMessage, `Invocation "${mutation.invocationId}".cancelledAtMessage`, {
                  min: 0,
              });

    if (mutation.status === 'completed') return {};

    return {
        ...(partialContent === undefined ? {} : { partialContent }),
        ...(cancelledAtMessage === undefined ? {} : { cancelledAtMessage })
    };
};

export type CanonicalView = {
    threads: Record<string, CanonicalThread>;
    stores: Record<RecordStoreName, CanonicalStore>;
    // The store-level half of the unified record engine: the ONE id counter every
    // collection draws from (F3). The per-collection `stores` entries hold the records;
    // this holds the numbering.
    records: { nextId: number };
    results: Record<string, HarnessAgentResultSnapshot>;
    // T10 finding M3: which lane epoch wrote each archived invocation. The core's own
    // identity rule makes a HOST thread's invocation id its THREAD id (harness.ts
    // `invocationIdOf`), and the same is true of an agent default conversation
    // (`agent:<name>`), so one conversation legitimately archives the SAME id again on
    // every later turn. Ownership is what distinguishes that writer updating its own slot
    // from a second lane colliding into it - the id alone cannot, because it is shared by
    // design. No entry means "no live lane owns it": the session archived it through its own
    // run, this authority was rebuilt, or the owning lane was reclaimed. An id-keyed archive
    // is a REPLACE by core contract, so the next writer of that conversation adopts the slot;
    // only a DIFFERENT live epoch is a collision.
    resultOwners: Record<string, number>;
    tools: Record<string, CanonicalTool>;
    createdToolCount: number;
    memory: Record<string, unknown>;
    discovery: { enabled: string[] };
};

export type CanonicalBounds = {
    maxThreads: number;
    maxRecordsPerStore: number;
    maxResults: number;
    maxCreatedTools: number;
    maxEnabledTools: number;
    maxMessagesPerThread: number;
};

export const DEFAULT_BOUNDS: CanonicalBounds = {
    // Bound values come from the core itself, so a lane commit can never let the
    // session grow past what the runtime persists or retains (T3 finding F10).
    maxThreads: MAX_THREAD_RECORDS,
    maxRecordsPerStore: MAX_RECORDS_PER_STORE,
    maxResults: AGENT_RESULT_RETENTION,
    maxCreatedTools: DEFAULT_CREATED_TOOLS_LIMIT,
    maxEnabledTools: 32,
    maxMessagesPerThread: MAX_MESSAGES_PER_THREAD
};

export const emptyCanonicalView = (): CanonicalView => ({
    threads: {},
    stores: {
        // The four built-in collections (records-engine T3). `nextId` is the mirrored
        // store-level counter; `records.nextId` below is the authoritative one.
        tasks: { items: [], nextId: 1 },
        chapters: { items: [], nextId: 1 },
        profiles: { items: [], nextId: 1 },
        locations: { items: [], nextId: 1 }
    },
    records: { nextId: 1 },
    results: {},
    resultOwners: {},
    tools: {},
    createdToolCount: 0,
    memory: {},
    discovery: { enabled: [] }
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

// `expects` is the digest of the value the lane read. For a create there is nothing
// to expect, so the field is absent and the authority mints the identity itself.
export type SharedMutation =
    | { kind: 'record:add'; store: RecordStoreName; record: Omit<CanonicalRecord, 'id'> }
    | { kind: 'record:update'; store: RecordStoreName; id: string; patch: Record<string, unknown>; expects: string }
    | { kind: 'record:remove'; store: RecordStoreName; id: string; expects: string }
    | { kind: 'thread:create'; agent: string; ownerThreadId?: string; label?: string }
    | { kind: 'thread:status'; threadId: string; status: 'idle' | 'stopped'; expects: string }
    | { kind: 'transcript:append'; threadId: string; fromLength: number; messages: HarnessMessage[] }
    // pipeline T4.1: an IN-PLACE rewrite of the part of the transcript this lane has already
    // committed — `expectedLength` whole entries, in canonical order — compare-and-set against
    // the digest of that prefix as this lane last ADOPTED it. It is the op an append cannot be:
    // a plugin's `setIncluded`/`edit` writes an already-committed entry without changing the
    // length, so the append condition (`transcript.length > committedLength`) never fires for
    // it (finding F6) and the change died with the worker process.
    //
    // WHY A WHOLE-PREFIX PATCH AND NOT A SPARSE ONE:
    //   1. the CAS is whole-prefix, so it cannot be trusted per entry anyway — one changed byte
    //      anywhere in the committed prefix fails the digest and the lane re-reads canonical;
    //   2. a whole-prefix replace makes the fold's apply trivially ATOMIC (`splice` one range)
    //      against a view the fold already proved, and atomic-per-op is rule F10 here;
    //   3. the cost is already inside the envelope this lane pays: `deriveOperations` takes a
    //      whole `snapshot()` of the replica every boundary, and the authority folds against a
    //      whole `snapshot()` every group, so a prefix copy on the rare round that edited a
    //      committed entry is not the thing that needs optimising;
    //   4. it converges: the lane adopts the authority's digest from the receipt, so one
    //      refusal plus one re-read ends the argument instead of re-litigating an entry index.
    //
    // WHY A NEW KIND AND NOT A WIDER `transcript:append`: the fold applies ops IN ORDER, so the
    // in-place patch is emitted BEFORE the append in the same group. Making the append carry both
    // would overload `fromLength` with "the prefix you may rewrite AND the point you may extend",
    // and a pure in-place change (length identical) would still be unrepresentable. It is also
    // additive both directions: a worker that predates T4 never sends it, and a worker newer than
    // its coordinator gets a named `invalid-mutation` refusal instead of a silently ignored op.
    //
    // The name says PATCH, not SYNC: `transcript:sync` is already the REQUEST a lane raises to
    // PULL canonical state (./lane-authority.ts). One name per direction, or a reader cannot tell
    // who is overwriting whom.
    | {
          kind: 'transcript:patch';
          threadId: string;
          // The committed prefix this lane replaces, and the length its `expects` digest was
          // taken over. `messages.length` MUST equal it — a mismatch is `invalid-mutation`.
          expectedLength: number;
          // `digestMemoryValue` of the canonical prefix as this lane last adopted it (the
          // receipt, the turn-start sync, or the hello snapshot). Key-order independent, like
          // every other digest on this protocol (./lane-memory.ts).
          expects: string;
          // The whole committed prefix, as it now is on this replica, in canonical order.
          messages: HarnessMessage[];
      }
    | { kind: 'memory:set'; key: string; value: unknown; expects: string }
    | { kind: 'memory:delete'; key: string; expects: string }
    | {
          kind: 'result:archive';
          invocationId: string;
          sequence: number;
          completedOrder: number;
          agent: string;
          role: 'primary' | 'subagent';
          // The run's origin (root / delegation / fork / autoanswer). Named `runKind`
          // because `kind` is this union's own discriminator.
          runKind: HarnessAgentResultSnapshot['kind'];
          status: HarnessAgentResultSnapshot['status'];
          content: string;
          error?: string;
          // The PERSISTENT conversation this invocation ran in (stress report #6,
          // 2026-11-14). Optional so an older send stays valid, and the fold ignores it —
          // `archiveDigestOf` projects only the fields a writer owns, and the conversation
          // is not one of them. The AUTHORITY needs it: `harness.archiveInvocation` writes
          // `threadId` onto the record, and `purgeThread`'s delete-cascade predicate is
          // `record.threadId`. Without it a lane-archived result has no owner at all, so the
          // same `threadDelete` removed an inline result and kept a lane one.
          //
          // The lane sets it to its own target conversation: a lane replica refuses every
          // nested-run door in worker mode (src/server/workers/capability.ts
          // NESTED_RUN_TOOL_NAMES — `delegate` and `threadFork` are refused before they
          // execute), so the only invocation it can produce IS the conversation it writes.
          // A result that merely came back in the rebuilt snapshot is skipped by digest
          // before an op is ever built (./lane-worker-loop.ts, T10 finding M3), so an op
          // never re-parents somebody else's record.
          threadId?: string;
          // Review finding #5 / issues 0020 + 0033 (2026-11-14): the FORENSIC PAIR of a run that
          // did not finish — what the stopped run actually said, and how many messages it had
          // committed when it stopped. Optional so an older send stays valid (a lane built against
          // the previous payload archives the same row it always did, just without the forensics).
          //
          // Both fields are writer-owned: the lane's replica produced them in its own
          // `finishInvocation`, the authority stores them verbatim, and `archiveDigestOf` covers
          // them, so a canonical row moving from no-pair to pair is an op the writer must send (and
          // one it must not skip). A malformed value is refused, never coerced — see
          // `readArchiveForensicPair` below, which applies the snapshot reader's own bounds so a bad
          // payload cannot persist into the view, and src/harness.ts's `archiveInvocation` applies
          // the identical rule on the live side.
          partialContent?: string;
          cancelledAtMessage?: number;
      }
    | { kind: 'tool:create'; name: string; source: string; revision: string }
    | { kind: 'tool:replace'; name: string; source: string; revision: string; expects: string }
    | { kind: 'tool:remove'; name: string; expects: string }
    | { kind: 'discovery:enable'; names: string[] };

export type MutationRejectionCode =
    | 'epoch-superseded'
    // The journal said no to this seq for a reason the lane can act on. Mapped from
    // CommitJournal.accepts (T10 finding S5), so a duplicate send and a frame behind the
    // lane's own watermark are no longer both reported as "epoch superseded".
    | 'seq-duplicate'
    | 'seq-behind'
    | 'not-writer'
    | 'unknown-thread'
    | 'unknown-record'
    | 'unknown-store'
    | 'unknown-tool'
    | 'stale-record'
    | 'stale-memory'
    | 'stale-tool'
    | 'prefix-moved'
    | 'unowned-mutation'
    // T10 finding M2: the fold refused a LATER op in the same group, so nothing in the
    // group moved at all. Every op the fold would have applied is reported with this code
    // and NO effect, because a lane adopts committed facts from receipts only.
    | 'group-rolled-back'
    // T10 finding S6: the lane wrote a memory key outside the window it was given.
    | 'memory-undeclared'
    | 'capacity-threads'
    | 'capacity-records'
    | 'capacity-results'
    | 'capacity-tools'
    | 'capacity-discovery'
    | 'capacity-transcript'
    | 'memory-untransferable'
    | 'invalid-mutation';

export type MutationReceipt = {
    opId: number;
    seq: number;
    laneEpoch: number;
    status: 'applied' | 'rejected';
    rejection?: { code: MutationRejectionCode; message: string };
    // The canonical facts the lane must adopt. A lane advances its committed base from
    // THESE, per receipt (T10 finding M2): an applied op's facts are adopted even when the
    // GROUP around them did not land, and a rejected op adopts only the canonical digest
    // or length this effect carries - never its own guess. That rebase is what lets the
    // next boundary succeed instead of replaying the same refusal forever.
    effect?: {
        mintedId?: string;
        length?: number;
        digest?: string;
        watermark?: number;
        // A tool registration is a REGISTRY change: the authority applies it first,
        // then broadcasts it so every live replica installs the same revision. A
        // lane's own create is therefore not a private mutation (F3/F9/F10).
        broadcast?: { name: string; source: string; revision: string; removed: boolean };
    };
};

// One mutation group = the ops a lane wants applied as a unit at one commit boundary.
export type MutationGroup = {
    laneEpoch: number;
    // Monotonic per lane. The journal refuses a gap, a duplicate, or a late group
    // from a superseded epoch, so ordering is decided in exactly one place.
    seq: number;
    ops: SharedMutation[];
};

export type GroupOutcome = {
    seq: number;
    status: 'applied' | 'rejected' | 'partial';
    receipts: MutationReceipt[];
    // True only when EVERY op applied. A partial group rolled the staged view back, so the
    // lane must not report progress for it (F8: no success on a rejected mutation).
    //
    // T10 finding M2: `complete: false` also means NOTHING moved on the live canonical
    // object. The applier must not replay the individually-applied receipts of an
    // incomplete group - the retired behaviour left half a group in a live store while the
    // lane, which adopts nothing from an incomplete group, kept a base that no longer
    // matched canonical, i.e. permanent divergence plus a turn that can never publish.
    complete: boolean;
};

// ---------------------------------------------------------------------------
// Writer leases (F5: one writer per shared conversation)
// ---------------------------------------------------------------------------

export type LeaseScope = { kind: 'thread'; id: string } | { kind: 'agent'; name: string };

export const leaseKeyOf = (scope: LeaseScope): string =>
    scope.kind === 'thread' ? `thread:${scope.id}` : `agent:${scope.name}`;

export type WriterLeaseLedger = {
    claim: (scope: LeaseScope, laneEpoch: number) => { ok: boolean; holder?: number };
    holderOf: (scope: LeaseScope) => number | undefined;
    release: (scope: LeaseScope, laneEpoch: number) => boolean;
    dropLane: (laneEpoch: number) => void;
    held: () => { key: string; laneEpoch: number }[];
};

export const createWriterLeaseLedger = (): WriterLeaseLedger => {
    const holders = new Map<string, number>();

    return {
        claim: (scope, laneEpoch) => {
            const key = leaseKeyOf(scope);
            const holder = holders.get(key);

            if (holder !== undefined && holder !== laneEpoch) return { ok: false, holder };

            holders.set(key, laneEpoch);

            return { ok: true };
        },
        holderOf: (scope) => holders.get(leaseKeyOf(scope)),
        release: (scope, laneEpoch) => {
            const key = leaseKeyOf(scope);

            if (holders.get(key) !== laneEpoch) return false;

            return holders.delete(key);
        },
        dropLane: (laneEpoch) => {
            for (const [key, holder] of [...holders.entries()]) {
                if (holder === laneEpoch) holders.delete(key);
            }
        },
        held: () => [...holders.entries()].map(([key, laneEpoch]) => ({ key, laneEpoch }))
    };
};

// Which conversation a mutation writes, i.e. the scope it must hold the writer lease
// for. A record/memory/tool/discovery op is NOT lease-guarded: it is CAS-guarded,
// because two lanes may legitimately add different records to the same store.
export const leaseScopeOf = (mutation: SharedMutation, view: CanonicalView): LeaseScope | undefined => {
    switch (mutation.kind) {
        case 'transcript:append':
        // T4.1: the in-place patch writes the SAME conversation the append would, so it needs
        // the SAME single-writer lease. A plugin's flag write is not a weaker claim on a shared
        // conversation than a message is.
        case 'transcript:patch': {
            const thread = view.threads[mutation.threadId];

            // A host thread belongs to the lane that runs it; an agent's DEFAULT
            // conversation is shared state, so it needs the single-writer lease.
            if (thread === undefined) return { kind: 'thread', id: mutation.threadId };

            return thread.id.startsWith('agent:') ? { kind: 'agent', name: thread.agent } : { kind: 'thread', id: thread.id };
        }
        case 'thread:status':
            return leaseScopeOf({ kind: 'transcript:append', threadId: mutation.threadId, fromLength: 0, messages: [] }, view);
        default:
            return undefined;
    }
};

// ---------------------------------------------------------------------------
// Journal (F8: receipts, ordering, and the terminal gate)
// ---------------------------------------------------------------------------

export type CommitJournal = {
    // A lane (re)started at this epoch: fresh ordering, and any earlier mark of death
    // for it is cleared.
    open: (laneEpoch: number) => void;
    // The lane stopped, crashed, or was reclaimed: every later frame naming this
    // epoch is refused, which is what keeps a late `turn-done` or a late mutation
    // from touching a conversation somebody else now owns (T3 finding F9).
    supersede: (laneEpoch: number) => void;
    accepts: (laneEpoch: number, seq: number) => { ok: boolean; code?: 'epoch-superseded' | 'seq-behind' | 'seq-duplicate' };
    settle: (laneEpoch: number, seq: number, complete: boolean) => void;
    appliedThrough: (laneEpoch: number) => number;
    // A turn may be reported as `done` only once the group carrying its FINAL state
    // has been applied: `tool_result` and the success frame travel the same ordered
    // chain, so a client can never see a completed turn whose transcript the
    // authority refused (T3 finding F8).
    mayPublishSuccess: (laneEpoch: number, terminalSeq: number) => boolean;
};

export const createCommitJournal = (): CommitJournal => {
    const state = new Map<number, { through: number; settled: Set<number> }>();
    const superseded = new Set<number>();

    return {
        open: (laneEpoch) => {
            superseded.delete(laneEpoch);
            if (!state.has(laneEpoch)) state.set(laneEpoch, { through: 0, settled: new Set<number>() });
        },
        supersede: (laneEpoch) => {
            superseded.add(laneEpoch);
        },
        accepts: (laneEpoch, seq) => {
            if (superseded.has(laneEpoch)) return { ok: false, code: 'epoch-superseded' };

            const lane = state.get(laneEpoch);

            // An epoch the coordinator never opened is a dead one: only the coordinator
            // opens epochs, so an unknown epoch can only mean "this lane is gone".
            if (lane === undefined) return { ok: false, code: 'epoch-superseded' };
            if (lane.settled.has(seq)) return { ok: false, code: 'seq-duplicate' };
            if (seq <= lane.through) return { ok: false, code: 'seq-behind' };

            return { ok: true };
        },
        settle: (laneEpoch, seq, complete) => {
            const lane = state.get(laneEpoch);

            if (lane === undefined) return;

            // Only a COMPLETE group moves the applied watermark; a rejected or
            // partial group leaves it exactly where it was (F7).
            if (complete) lane.through = seq;
            lane.settled.add(seq);
        },
        appliedThrough: (laneEpoch) => state.get(laneEpoch)?.through ?? 0,
        mayPublishSuccess: (laneEpoch, terminalSeq) => (state.get(laneEpoch)?.through ?? 0) >= terminalSeq
    };
};

// A lane epoch is retired by the coordinator (stop, crash, or reclaim). A test seam
// for the two-epoch case the store will exercise: the new epoch is opened, the old one
// is superseded, and only the first may still move state.
export const replaceLaneEpoch = (journal: CommitJournal, deadEpoch: number, bornEpoch: number): void => {
    journal.supersede(deadEpoch);
    journal.open(bornEpoch);
};

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

export type ApplyContext = {
    laneEpoch: number;
    bounds?: Partial<CanonicalBounds>;
    // The scopes this lane currently holds a writer lease for. Checked per op, so a
    // lane cannot append to a conversation it never claimed (F6).
    leases: WriterLeaseLedger;
    // The coordinator's id ledger. `record:add` and `thread:create` mint from it, so
    // the published `nextId`/`threadSequence` is always one past the largest id.
    // `observe` folds back an id the AUTHORITY minted, keeping the ledger ahead of
    // anything a lane may be handed next.
    identity: IdentityLedger;
    // T10 finding S6: the memory keys this lane was actually given. A write to a key
    // outside this window is REFUSED with the canonical digest, because the lane's own
    // base never covered that key - accepting it would be a blind overwrite of a sibling
    // or of an operator edit. `undefined` means "this session declares no window", which is
    // the unrestricted case ./lane-authority.ts already uses for `memory:window`.
    declaredKeys?: readonly string[];
};

const boundsOf = (partial?: Partial<CanonicalBounds>): CanonicalBounds => ({ ...DEFAULT_BOUNDS, ...(partial ?? {}) });

const reject = (
    receiptBase: Pick<MutationReceipt, 'opId' | 'seq' | 'laneEpoch'>,
    code: MutationRejectionCode,
    message: string
): MutationReceipt => ({ ...receiptBase, status: 'rejected', rejection: { code, message } });

const digestOfRecord = (record: CanonicalRecord | undefined): string =>
    record === undefined ? ABSENT_DIGEST : digestMemoryValue(record);

// Apply ONE mutation. Returns the receipt, and mutates `view` ONLY when the receipt
// says `applied` - a rejection leaves the canonical state untouched (atomic per op).
export const applySharedMutation = (
    view: CanonicalView,
    mutation: SharedMutation,
    context: ApplyContext & { opId: number; seq: number }
): MutationReceipt => {
    const base = { opId: context.opId, seq: context.seq, laneEpoch: context.laneEpoch };
    const bounds = boundsOf(context.bounds);

    // Every transcript/status op must be lease-held by THIS epoch, and the thread it
    // names must exist. An UNKNOWN thread is reported first: "no such conversation"
    // is the actionable reason, and a lease refusal would send the lane to claim
    // ownership of something that is not there.
    const scope = leaseScopeOf(mutation, view);
    const targetThreadId =
        mutation.kind === 'transcript:append' || mutation.kind === 'transcript:patch' || mutation.kind === 'thread:status'
            ? mutation.threadId
            : undefined;
    const targetKnown = targetThreadId === undefined || view.threads[targetThreadId] !== undefined;

    if (scope !== undefined && targetKnown) {
        const holder = context.leases.holderOf(scope);

        if (holder !== context.laneEpoch) {
            return reject(
                base,
                'not-writer',
                `Lane ${context.laneEpoch} may not write ${leaseKeyOf(scope)}; the writer lease is held by ${holder === undefined ? 'nobody' : `lane ${holder}`}. Claim it, or run the conversation as its own child thread.`
            );
        }
    }

    switch (mutation.kind) {
        case 'record:add': {
            const store = view.stores[mutation.store];

            if (store === undefined) {
                return reject(base, 'unknown-store', `Unknown record store "${mutation.store}".`);
            }

            if (store.items.length >= bounds.maxRecordsPerStore) {
                return reject(base, 'capacity-records', `The ${mutation.store} store holds at most ${bounds.maxRecordsPerStore} records.`);
            }

            // ONE space for every collection (F3): a task id and a chapter id are
            // drawn from the same lease, so two collections can never mint the same id.
            const allocation = context.identity.allocate('record', 1, context.laneEpoch);

            if (!allocation.ok) {
                return reject(base, 'capacity-records', allocation.fault.message);
            }

            const mintedId = idOf('record', allocation.lease.start);
            const record: CanonicalRecord = { ...mutation.record, id: mintedId } as CanonicalRecord;
            store.items.push(record);

            // The published counter is the LEDGER's value for this space's units -
            // one past the largest minted id - which is exactly what the core's
            // snapshot validator requires (the F1 rule). It is the STORE-level number:
            // the per-store mirror is written alongside it so both read the same fact.
            view.records.nextId = allocation.published;
            store.nextId = allocation.published;

            return {
                ...base,
                status: 'applied',
                effect: { mintedId, watermark: allocation.published, digest: digestOfRecord(record) }
            };
        }

        case 'record:update': {
            const store = view.stores[mutation.store];

            if (store === undefined) return reject(base, 'unknown-store', `Unknown record store "${mutation.store}".`);

            const current = store.items.find((item) => item.id === mutation.id);

            if (current === undefined) return reject(base, 'unknown-record', `No ${mutation.store} record with id "${mutation.id}".`);

            const digest = digestOfRecord(current);

            if (digest !== mutation.expects) {
                // A real concurrent edit. Refused, and the lane is handed the current
                // digest so it can re-read and re-apply rather than silently lose it.
                return {
                    ...base,
                    status: 'rejected',
                    rejection: { code: 'stale-record', message: `The ${mutation.store} record "${mutation.id}" changed since this lane read it.` },
                    effect: { digest }
                };
            }

            const updated = { ...current, ...mutation.patch, id: current.id } as CanonicalRecord;
            store.items[store.items.indexOf(current)] = updated;

            return { ...base, status: 'applied', effect: { digest: digestOfRecord(updated) } };
        }

        case 'record:remove': {
            const store = view.stores[mutation.store];

            if (store === undefined) return reject(base, 'unknown-store', `Unknown record store "${mutation.store}".`);

            const current = store.items.find((item) => item.id === mutation.id);

            if (current === undefined) return reject(base, 'unknown-record', `No ${mutation.store} record with id "${mutation.id}".`);

            const digest = digestOfRecord(current);

            if (digest !== mutation.expects) {
                return {
                    ...base,
                    status: 'rejected',
                    rejection: { code: 'stale-record', message: `The ${mutation.store} record "${mutation.id}" changed since this lane read it.` },
                    effect: { digest }
                };
            }

            store.items = store.items.filter((item) => item.id !== mutation.id);

            return { ...base, status: 'applied', effect: { digest: ABSENT_DIGEST } };
        }

        case 'thread:create': {
            if (Object.keys(view.threads).length >= bounds.maxThreads) {
                return reject(base, 'capacity-threads', `A session holds at most ${bounds.maxThreads} conversations.`);
            }

            const allocation = context.identity.allocate('thread', 1, context.laneEpoch);

            if (!allocation.ok) return reject(base, 'capacity-threads', allocation.fault.message);

            const id = idOf('thread', allocation.lease.start);
            const thread: CanonicalThread = {
                id,
                agent: mutation.agent,
                status: 'idle',
                sequence: allocation.lease.start,
                ...(mutation.label === undefined ? {} : { label: mutation.label }),
                ...(mutation.ownerThreadId === undefined ? {} : { ownerThreadId: mutation.ownerThreadId }),
                messages: []
            };

            view.threads[id] = thread;

            // The creating lane is the writer of its own child conversation.
            context.leases.claim({ kind: 'thread', id }, context.laneEpoch);

            return {
                ...base,
                status: 'applied',
                effect: { mintedId: id, watermark: allocation.published, digest: digestMemoryValue(thread) }
            };
        }

        case 'thread:status': {
            const thread = view.threads[mutation.threadId];

            if (thread === undefined) return reject(base, 'unknown-thread', `Thread "${mutation.threadId}" is not in the canonical state.`);

            const digest = digestMemoryValue({ status: thread.status, label: thread.label });

            if (digest !== mutation.expects) {
                return {
                    ...base,
                    status: 'rejected',
                    rejection: { code: 'stale-record', message: `Thread "${mutation.threadId}" changed since this lane read it.` },
                    effect: { digest }
                };
            }

            thread.status = mutation.status;

            return { ...base, status: 'applied', effect: { digest: digestMemoryValue({ status: thread.status, label: thread.label }) } };
        }

        case 'transcript:append': {
            const thread = view.threads[mutation.threadId];

            if (thread === undefined) return reject(base, 'unknown-thread', `Thread "${mutation.threadId}" is not in the canonical state.`);

            if (thread.messages.length !== mutation.fromLength) {
                // The append-safe answer to a concurrent writer: refuse, report the
                // canonical length, and let the lane re-read. Nothing is overwritten.
                return {
                    ...base,
                    status: 'rejected',
                    rejection: {
                        code: 'prefix-moved',
                        message: `Thread "${mutation.threadId}" holds ${thread.messages.length} messages, not ${mutation.fromLength}; re-read before appending.`
                    },
                    effect: { length: thread.messages.length, digest: digestMemoryValue(thread.messages) }
                };
            }

            if (thread.messages.length + mutation.messages.length > bounds.maxMessagesPerThread) {
                return reject(base, 'capacity-transcript', `Thread "${mutation.threadId}" would exceed ${bounds.maxMessagesPerThread} messages.`);
            }

            thread.messages.push(...mutation.messages);

            return { ...base, status: 'applied', effect: { length: thread.messages.length, digest: digestMemoryValue(thread.messages) } };
        }

        case 'transcript:patch': {
            const thread = view.threads[mutation.threadId];

            if (thread === undefined) return reject(base, 'unknown-thread', `Thread "${mutation.threadId}" is not in the canonical state.`);

            // The op states the prefix it replaces, so a length that disagrees with its own
            // payload is a malformed send, not a conflict: naming it `invalid-mutation` keeps
            // `prefix-moved` meaning exactly one thing for a lane (canonical moved, re-read).
            if (!Number.isInteger(mutation.expectedLength) || mutation.expectedLength < 0) {
                return reject(
                    base,
                    'invalid-mutation',
                    `Thread "${mutation.threadId}" patch needs a non-negative committed-prefix length; received ${JSON.stringify(mutation.expectedLength)}.`
                );
            }

            if (mutation.messages.length !== mutation.expectedLength) {
                return reject(
                    base,
                    'invalid-mutation',
                    `Thread "${mutation.threadId}" patch names ${mutation.expectedLength} committed entries but carries ${mutation.messages.length}.`
                );
            }

            // Both refusals below answer with the SAME facts an append refusal carries — the
            // canonical length and the canonical digest — because both send the lane to the same
            // place: the `transcript:sync` pull and a re-derivation (T4.1 reuses the existing
            // `prefix-moved` → rebase path rather than inventing a second conflict story).
            if (thread.messages.length < mutation.expectedLength) {
                // Canonical got SHORTER than this lane's base (a reset or a host repair landed
                // while the lane was alive), so the prefix it wants to rewrite no longer exists.
                return {
                    ...base,
                    status: 'rejected',
                    rejection: {
                        code: 'prefix-moved',
                        message: `Thread "${mutation.threadId}" holds ${thread.messages.length} messages, not ${mutation.expectedLength}; re-read before patching.`
                    },
                    effect: { length: thread.messages.length, digest: digestMemoryValue(thread.messages) }
                };
            }

            const canonicalPrefix = digestMemoryValue(thread.messages.slice(0, mutation.expectedLength));

            if (canonicalPrefix !== mutation.expects) {
                // Somebody else rewrote the committed prefix: this lane's in-place change is
                // refused WHOLE, never merged in entry by entry, because the digest cannot say
                // which entries it covers. Nothing moves; the lane re-reads and its policy
                // re-derives its decision on the next round.
                return {
                    ...base,
                    status: 'rejected',
                    rejection: {
                        code: 'prefix-moved',
                        message: `The first ${mutation.expectedLength} messages of thread "${mutation.threadId}" changed since this lane read them; re-read before patching.`
                    },
                    effect: { length: thread.messages.length, digest: digestMemoryValue(thread.messages) }
                };
            }

            // Replace the prefix IN PLACE (splice, not reassign): the thread object the next op
            // in this group reads is this one, and an append that follows a patch in the same
            // group must land on the rewritten prefix, not on a detached array.
            thread.messages.splice(0, mutation.expectedLength, ...mutation.messages);

            const patchedPrefix = thread.messages.slice(0, mutation.expectedLength);

            return {
                ...base,
                status: 'applied',
                // `length` here is the COMMITTED PREFIX the lane holds, not the whole transcript
                // (which a patch never changes, and which may legitimately be longer than the
                // prefix — a coordinator append between the lane's read and its commit). The
                // append receipt's `length` is the whole transcript; the two scopes are named
                // apart because a lane that adopted the wrong one would either strand its own
                // tail or re-send the same prefix forever.
                effect: { length: mutation.expectedLength, digest: digestMemoryValue(patchedPrefix) }
            };
        }

        case 'memory:set': {
            // S6: the declared window is enforced HERE, authority-side, not only by the
            // lane's own derivation. A write to a key this lane was never given carries a
            // digest it invented (it could not have read the canonical value), so it is
            // refused with the canonical digest and the lane re-bases.
            if (context.declaredKeys !== undefined && !context.declaredKeys.includes(mutation.key)) {
                return {
                    ...base,
                    status: 'rejected',
                    rejection: {
                        code: 'memory-undeclared',
                        message: `harness.memory["${mutation.key}"] is outside the memory window this lane was given; it cannot write a key it never read.`
                    },
                    effect: { digest: expectsDigestOf(view.memory[mutation.key]) }
                };
            }

            const outcome = applyMemoryWrite(view.memory, { key: mutation.key, expected: mutation.expects, value: mutation.value });

            if (!outcome.applied) {
                const code: MutationRejectionCode = outcome.status === 'untransferable' ? 'memory-untransferable' : 'stale-memory';

                return {
                    ...base,
                    status: 'rejected',
                    rejection: { code, message: outcome.reason ?? `harness.memory["${mutation.key}"] changed since this lane read it.` },
                    effect: { digest: outcome.digest }
                };
            }

            return { ...base, status: 'applied', effect: { digest: outcome.digest } };
        }

        case 'memory:delete': {
            // S6: same window rule as `memory:set`. This is exactly the write that lost a
            // sibling's key in the retired merge (F4): a lane deleting what it never read.
            if (context.declaredKeys !== undefined && !context.declaredKeys.includes(mutation.key)) {
                return {
                    ...base,
                    status: 'rejected',
                    rejection: {
                        code: 'memory-undeclared',
                        message: `harness.memory["${mutation.key}"] is outside the memory window this lane was given; it cannot delete a key it never read.`
                    },
                    effect: { digest: expectsDigestOf(view.memory[mutation.key]) }
                };
            }

            const outcome = applyMemoryWrite(view.memory, { key: mutation.key, expected: mutation.expects, remove: true });

            if (!outcome.applied) {
                return {
                    ...base,
                    status: 'rejected',
                    rejection: { code: 'stale-memory', message: `harness.memory["${mutation.key}"] changed since this lane read it.` },
                    effect: { digest: outcome.digest }
                };
            }

            return { ...base, status: 'applied', effect: { digest: outcome.digest } };
        }

        case 'result:archive': {
            // Review finding #5 / issues 0020 + 0033: the payload's forensic pair is checked HERE,
            // first, before a single line below touches `view`. This fold has already applied the
            // earlier ops of the group to the view it was handed, so a row that carried a malformed
            // partial (a number, a blank string, a negative message index) would otherwise persist
            // into the canonical view — and into the next snapshot — while the lane was told nothing
            // worse than `applied`. Refusing here keeps the rule honest: a malformed pair never
            // becomes canonical state on either seam.
            let pair: { partialContent?: string; cancelledAtMessage?: number };

            try {
                pair = readArchiveForensicPair(mutation);
            } catch (error) {
                return reject(
                    base,
                    'invalid-mutation',
                    `Archived invocation "${mutation.invocationId}" carries a malformed forensic pair: ${error instanceof Error ? error.message : String(error)}`
                );
            }

            const existing = view.results[mutation.invocationId];

            if (existing !== undefined) {
                // The digest of the slot AS IT IS, so a refusal still hands the lane the
                // canonical fact it needs to stop re-sending.
                const digest = archiveDigestOf(existing);
                const owner = view.resultOwners[mutation.invocationId];

                // A DIFFERENT lane epoch owns this id: a real cross-epoch collision, refused.
                // `undefined` means "no live lane owns it" - the session archived it through
                // its own run, this authority was rebuilt, or the owning lane was reclaimed -
                // and in every one of those cases the writer of the conversation may update the
                // slot, exactly as the core's id-keyed `archiveInvocation` does inline.
                if (owner !== undefined && owner !== context.laneEpoch) {
                    return {
                        ...base,
                        status: 'rejected',
                        rejection: {
                            code: 'not-writer',
                            message: `Invocation "${mutation.invocationId}" is archived by lane ${owner}; this lane (${context.laneEpoch}) does not own that identity.`
                        },
                        effect: { digest }
                    };
                }

                // M3: this lane is re-archiving the id IT owns. That is the normal second
                // turn of one conversation, because a host thread's invocation id IS the
                // thread id and an agent default conversation's is `agent:<name>` - the
                // core rule `invocationIdOf` implements inline, where the archive simply
                // replaces the slot (`archiveInvocation` returns `replaced: true`). The
                // retired behaviour here refused the repeat, so the canonical archive kept
                // the FIRST answer for the whole life of the conversation.
                //
                // #6/0033: `threadId` is carried into the canonical record here as well as
                // into the core's own archive. The canonical view is what this authority
                // persists and rebuilds from, so a slot that dropped the owner left the
                // delete-cascade predicate with nothing to match after a reload - the same
                // lane/inline divergence, one layer down. `archiveDigestOf` ignores the key,
                // so this cannot disturb the writer's idempotency test.
                const replacedRecord: HarnessAgentResultSnapshot = {
                    invocationId: mutation.invocationId,
                    sequence: mutation.sequence,
                    completedOrder: mutation.completedOrder,
                    agent: mutation.agent,
                    role: mutation.role,
                    kind: mutation.runKind,
                    status: mutation.status,
                    content: mutation.content,
                    ...(mutation.error === undefined ? {} : { error: mutation.error }),
                    // #5/0020+0033: the pair, validated above and projected by the core's own rule
                    // (`readArchiveForensicPair`) — a `completed` status yields `{}`, so a row that is
                    // being replaced by a completed archive cannot keep a partial that outlived the
                    // cancellation it described. This is the SECOND place the rule must hold: the live
                    // write in src/harness.ts applies the identical drop, and the digest of this slot
                    // is compared against the digest of that record. Drop on one side only and the two
                    // digests disagree permanently, which is the lane re-archiving the same row on
                    // every boundary.
                    ...pair,
                    ...(mutation.threadId === undefined ? {} : { threadId: mutation.threadId })
                };

                view.results[replacedRecord.invocationId] = replacedRecord;
                context.identity.observe('completedOrder', replacedRecord.completedOrder);

                return { ...base, status: 'applied', effect: { digest: archiveDigestOf(replacedRecord) } };
            }

            if (Object.keys(view.results).length >= bounds.maxResults) {
                // Retention drops the OLDEST completed entry, exactly like the core
                // archive; the new result is still recorded. The owner bookkeeping goes
                // with it, so the slot is free again if the id ever returns.
                const oldest = Object.values(view.results).sort((left, right) => left.completedOrder - right.completedOrder)[0];

                if (oldest !== undefined) {
                    delete view.results[oldest.invocationId];
                    delete view.resultOwners[oldest.invocationId];
                }
            }

            const record: HarnessAgentResultSnapshot = {
                invocationId: mutation.invocationId,
                sequence: mutation.sequence,
                completedOrder: mutation.completedOrder,
                agent: mutation.agent,
                role: mutation.role,
                kind: mutation.runKind,
                status: mutation.status,
                content: mutation.content,
                ...(mutation.error === undefined ? {} : { error: mutation.error }),
                // #6/0033: the owner is part of the canonical row, not only of the core's own
                // archive — see the `replacedRecord` above for why dropping it here is what let
                // a lane conversation's results survive a `threadDelete` after a reload.
                ...(mutation.threadId === undefined ? {} : { threadId: mutation.threadId }),
                // #5/0020+0033: the forensic pair of a run that did not finish, with the same
                // validation and the same completed-drop as the replacement branch above. A first
                // archive is the case the pair exists for: a cancelled lane child's canonical row gets
                // what it SAID, not just the fact that it stopped.
                ...pair
            };

            view.results[record.invocationId] = record;
            view.resultOwners[record.invocationId] = context.laneEpoch;

            // Fold the leased ids back so the ledger stays ahead of everything issued,
            // including anything the authority itself mints between lane commits.
            const minted = Number(record.invocationId);

            if (Number.isInteger(minted)) context.identity.observe('invocation', minted);
            context.identity.observe('completedOrder', record.completedOrder);

            return { ...base, status: 'applied', effect: { digest: archiveDigestOf(record) } };
        }

        case 'tool:create': {
            if (view.tools[mutation.name] !== undefined) {
                return reject(base, 'capacity-tools', `A tool named "${mutation.name}" already exists; use tool:replace.`);
            }

            if (view.createdToolCount >= bounds.maxCreatedTools) {
                return reject(
                    base,
                    'capacity-tools',
                    `This session has spent its lifetime budget of ${bounds.maxCreatedTools} created tools.`
                );
            }

            view.tools[mutation.name] = { name: mutation.name, source: mutation.source, revision: mutation.revision, replaced: false };
            // The budget is INCREMENTED by the authority when the op applies. A max()
            // merge across lanes is what lost increments before (F3).
            view.createdToolCount += 1;

            return {
                ...base,
                status: 'applied',
                effect: { digest: mutation.revision, broadcast: { name: mutation.name, source: mutation.source, revision: mutation.revision, removed: false } }
            };
        }

        case 'tool:replace': {
            const current = view.tools[mutation.name];

            if (current === undefined) return reject(base, 'unknown-tool', `No tool named "${mutation.name}" is installed.`);

            if (current.revision !== mutation.expects) {
                return {
                    ...base,
                    status: 'rejected',
                    rejection: { code: 'stale-tool', message: `Tool "${mutation.name}" was replaced by another writer; expected revision ${mutation.expects}, found ${current.revision}.` },
                    effect: { digest: current.revision }
                };
            }

            current.source = mutation.source;
            current.revision = mutation.revision;
            current.replaced = true;

            return {
                ...base,
                status: 'applied',
                effect: { digest: mutation.revision, broadcast: { name: mutation.name, source: mutation.source, revision: mutation.revision, removed: false } }
            };
        }

        case 'tool:remove': {
            const current = view.tools[mutation.name];

            if (current === undefined) return reject(base, 'unknown-tool', `No tool named "${mutation.name}" is installed.`);

            if (current.revision !== mutation.expects) {
                return {
                    ...base,
                    status: 'rejected',
                    rejection: { code: 'stale-tool', message: `Tool "${mutation.name}" changed; expected revision ${mutation.expects}.` },
                    effect: { digest: current.revision }
                };
            }

            delete view.tools[mutation.name];

            return {
                ...base,
                status: 'applied',
                effect: { digest: ABSENT_DIGEST, broadcast: { name: mutation.name, source: '', revision: ABSENT_DIGEST, removed: true } }
            };
        }

        case 'discovery:enable': {
            const enabled = [...new Set([...mutation.names, ...view.discovery.enabled])];

            if (enabled.length > bounds.maxEnabledTools) {
                return reject(base, 'capacity-discovery', `This session enables at most ${bounds.maxEnabledTools} searchable tools.`);
            }

            view.discovery.enabled = enabled;

            return { ...base, status: 'applied', effect: { digest: digestMemoryValue(enabled) } };
        }

        default:
            return reject(base, 'invalid-mutation', `Unsupported mutation kind: ${JSON.stringify((mutation as { kind: string }).kind)}`);
    }
};

// Apply a whole group ATOMICALLY: the ops run against a copy, and the canonical view
// is replaced only when every one of them applies. A rejection mid-group therefore
// cannot leave half a mutation in the live canonical state (F10), and the receipt
// list names the first op that failed.
//
// THE CALLER MUST HONOUR THE ROLLBACK (T10 finding M2): when `complete` is false the
// staged view was thrown away, so the LIVE applier must apply none of the individually
// `applied` receipts and must report them through `rolledBackReceipts`. Replaying a
// per-op `applied` receipt of a rolled-back group is what made the live object and the
// lane's base diverge for the rest of the lane's life.
export const applyMutationGroup = (
    view: CanonicalView,
    group: MutationGroup,
    context: Omit<ApplyContext, 'laneEpoch'> & { laneEpoch: number }
): { view: CanonicalView; outcome: GroupOutcome } => {
    if (group.ops.length > MUTATION_GROUP_LIMIT) {
        const receipts = group.ops.map((_, index) =>
            reject({ opId: index, seq: group.seq, laneEpoch: group.laneEpoch }, 'invalid-mutation', `A commit group carries at most ${MUTATION_GROUP_LIMIT} operations; this one carries ${group.ops.length}.`)
        );

        return { view, outcome: { seq: group.seq, status: 'rejected', receipts, complete: false } };
    }

    const staged: CanonicalView = structuredClone(view);
    const receipts: MutationReceipt[] = [];
    let failed = false;

    group.ops.forEach((mutation, index) => {
        const receipt = applySharedMutation(staged, mutation, { ...context, opId: index, seq: group.seq });

        if (receipt.status === 'rejected') failed = true;
        receipts.push(receipt);
    });

    if (failed) {
        // Nothing moved: the caller keeps its own view object, and the lane gets a
        // receipt for every op so it knows exactly what did not happen.
        return {
            view,
            outcome: { seq: group.seq, status: 'partial', receipts, complete: false }
        };
    }

    return { view: staged, outcome: { seq: group.seq, status: 'applied', receipts, complete: true } };
};

// Roll every receipt of a group that did NOT land back to a refusal (T10 finding M2).
//
// The staged fold answered each op on its own, so an incomplete group contains ops whose
// receipt says `applied` even though the rollback means the canonical object never saw
// them. Rewriting those to `group-rolled-back`, with their effects dropped, is what makes
// the lane's base correct: it adopts canonical facts from a receipt only when the receipt
// describes something that really happened, and the refusals that CAUSED the rollback keep
// their canonical digest/length so the next boundary can re-base instead of repeating.
export const rolledBackReceipts = (
    receipts: MutationReceipt[],
    ops: readonly SharedMutation[],
    laneEpoch: number,
    seq: number
): MutationReceipt[] =>
    receipts.map((receipt) =>
        receipt.status === 'rejected'
            ? receipt
            : {
                  opId: receipt.opId,
                  seq,
                  laneEpoch,
                  status: 'rejected' as const,
                  rejection: {
                      code: 'group-rolled-back' as MutationRejectionCode,
                      // The op KIND is named (never its payload: a transcript append can be
                      // 64 KiB) so the lane's operator can see which part of the boundary
                      // the refusal dragged down.
                      message: `Commit ${seq} was not applied as a unit, so operation ${receipt.opId} (${String(ops[receipt.opId]?.kind ?? 'unknown')}) moved nothing.`
                  }
              }
    );

// Digest used by a lane when it declares "this is the value I read".
export const expectsDigestOf = (value: unknown): string =>
    value === undefined ? ABSENT_DIGEST : digestMemoryValue(value);

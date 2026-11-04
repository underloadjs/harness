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
//   - a transcript is APPENDED at a known prefix length, so a lane cannot overwrite
//     text a sibling appended into the same conversation;
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
import type { HarnessAgentResultSnapshot, HarnessMessage } from '../../types';
import type { IdentityLedger } from './lane-identity';
import { idOf } from './lane-identity';
import { ABSENT_DIGEST, applyMemoryWrite, digestMemoryValue } from './lane-memory';

export const RECORD_STORES = ['todos', 'profiles', 'chapters', 'locations'] as const;
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
    status: 'idle' | 'running' | 'stopped';
    sequence: number;
    label?: string;
    ownerThreadId?: string;
    messages: HarnessMessage[];
};

export type CanonicalRecord = { id: string } & Record<string, unknown>;

export type CanonicalStore = { items: CanonicalRecord[]; nextId: number };

export type CanonicalTool = { name: string; source: string; revision: string; replaced: boolean };

export type CanonicalView = {
    threads: Record<string, CanonicalThread>;
    stores: Record<RecordStoreName, CanonicalStore>;
    results: Record<string, HarnessAgentResultSnapshot>;
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
        todos: { items: [], nextId: 1 },
        profiles: { items: [], nextId: 1 },
        chapters: { items: [], nextId: 1 },
        locations: { items: [], nextId: 1 }
    },
    results: {},
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
      }
    | { kind: 'tool:create'; name: string; source: string; revision: string }
    | { kind: 'tool:replace'; name: string; source: string; revision: string; expects: string }
    | { kind: 'tool:remove'; name: string; expects: string }
    | { kind: 'discovery:enable'; names: string[] };

export type MutationRejectionCode =
    | 'epoch-superseded'
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
    // The canonical facts the lane must adopt. A lane advances its committed base
    // ONLY from these values (F7), and adopts nothing at all from a rejection.
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
    // True only when EVERY op applied: a partial group rolled the view back, so the
    // lane must not report progress for it (F8: no success on a rejected mutation).
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
        case 'transcript:append': {
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
        mutation.kind === 'transcript:append' || mutation.kind === 'thread:status' ? mutation.threadId : undefined;
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

            const allocation = context.identity.allocate(`record:${mutation.store}`, 1, context.laneEpoch);

            if (!allocation.ok) {
                return reject(base, 'capacity-records', allocation.fault.message);
            }

            const mintedId = idOf(`record:${mutation.store}` as import('./lane-identity').IdSpace, allocation.lease.start);
            const record: CanonicalRecord = { ...mutation.record, id: mintedId } as CanonicalRecord;
            store.items.push(record);

            // The published counter is the LEDGER's value for this space's units -
            // one past the largest minted id - which is exactly what the core's
            // snapshot validator requires (the F1 rule).
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

        case 'memory:set': {
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
            if (view.results[mutation.invocationId] !== undefined) {
                const digest = digestMemoryValue(view.results[mutation.invocationId]);

                return {
                    ...base,
                    status: 'rejected',
                    rejection: { code: 'stale-record', message: `Invocation "${mutation.invocationId}" is already archived; identity ids must come from the authority.` },
                    effect: { digest }
                };
            }

            if (Object.keys(view.results).length >= bounds.maxResults) {
                // Retention drops the OLDEST completed entry, exactly like the core
                // archive; the new result is still recorded.
                const oldest = Object.values(view.results).sort((left, right) => left.completedOrder - right.completedOrder)[0];

                if (oldest !== undefined) delete view.results[oldest.invocationId];
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
                ...(mutation.error === undefined ? {} : { error: mutation.error })
            };

            view.results[record.invocationId] = record;

            // Fold the leased ids back so the ledger stays ahead of everything issued,
            // including anything the authority itself mints between lane commits.
            const minted = Number(record.invocationId);

            if (Number.isInteger(minted)) context.identity.observe('invocation', minted);
            context.identity.observe('completedOrder', record.completedOrder);

            return { ...base, status: 'applied', effect: { digest: digestMemoryValue(record) } };
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

// Digest used by a lane when it declares "this is the value I read".
export const expectsDigestOf = (value: unknown): string =>
    value === undefined ? ABSENT_DIGEST : digestMemoryValue(value);

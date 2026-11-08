// Lane commits: the authority-side fold of lane OPERATIONS, with receipts.
//
// These are the reviewer's reproductions from Temp/t3, expressed as cases the live
// applier must also satisfy: a minted id that the CORE validator accepts, two lanes
// that cannot mint the same identity, a budget that cannot lose an increment, a
// transcript that cannot lose a concurrent append, and a base that cannot advance on
// a mutation nobody accepted.
//
// Cross-references:
//   - ./lane-commit.ts   - applySharedMutation / applyMutationGroup / the journal
//   - ./lane-identity.ts - the id leases the fold consumes
//   - ./lane-memory.ts   - the CAS rules for memory ops
//   - ../../core/task.ts - readTaskStoreState, the validator a folded store must pass

import { describe, expect, it } from 'vitest';
import { readTaskStoreState, TASK_DEFAULT_LEASE_MS } from '../../core/task';
import {
    DEFAULT_BOUNDS,
    applyMutationGroup,
    applySharedMutation,
    archiveDigestOf,
    createCommitJournal,
    createWriterLeaseLedger,
    emptyCanonicalView,
    expectsDigestOf,
    leaseKeyOf,
    leaseScopeOf,
    replaceLaneEpoch,
    rolledBackReceipts
} from './lane-commit';
import type { CanonicalView, MutationGroup, SharedMutation } from './lane-commit';
import { createIdentityLedger } from './lane-identity';

const EPOCH_A = 1;
const EPOCH_B = 2;

// The frozen instant the T1 fixtures below write into a fold view, so a persisted
// `updatedAt` and a `leaseUntil` are one exact value each (src/core/task.ts derives
// both from Date). The fold itself never reads the clock.
const EPOCH_ISO = '2026-01-01T00:00:00.000Z';
const EPOCH_MS = Date.parse(EPOCH_ISO);

const context = (
    view: CanonicalView,
    laneEpoch = EPOCH_A,
    overrides: Partial<Parameters<typeof applySharedMutation>[2]> = {}
): Parameters<typeof applySharedMutation>[2] => ({
    laneEpoch,
    leases: createWriterLeaseLedger(),
    identity: createIdentityLedger({ thread: 1, invocation: 1, 'record:todos': 1, 'record:profiles': 1 }),
    opId: 0,
    seq: 1,
    ...overrides
});

// A canonical view holding one idle host thread owned by lane 1.
const viewWith = (threadId: string, messages: unknown[] = []): CanonicalView => ({
    ...emptyCanonicalView(),
    threads: {
        [threadId]: { id: threadId, agent: 'instruct', status: 'idle', sequence: 1, messages: messages as never }
    }
});

const claiming = (laneEpoch: number, threadId: string): Parameters<typeof applySharedMutation>[2] => {
    const leases = createWriterLeaseLedger();

    leases.claim({ kind: 'thread', id: threadId }, laneEpoch);

    return leases;
};

describe('record ops: the authority mints, and the result is a VALID store', () => {
    it('reproduces F1: three lane-created records leave a nextId readTaskStoreState accepts', () => {
        const view = emptyCanonicalView();
        const leases = createWriterLeaseLedger();
        const identity = createIdentityLedger({ 'record:todos': 1 });

        for (let added = 0; added < 3; added += 1) {
            const receipt = applySharedMutation(
                view,
                { kind: 'record:add', store: 'todos', record: { text: `task ${added}`, completed: false } },
                { laneEpoch: EPOCH_A, leases, identity, opId: added, seq: 1 }
            );

            expect(receipt.status).toBe('applied');
        }

        expect(view.stores.todos.items.map((item) => item.id)).toEqual(['2', '3', '4']);
        // The reviewer's failure mode: nextId left at the block start, below the
        // largest id, and the core REJECTED the snapshot.
        expect(view.stores.todos.nextId).toBe(5);
        expect(() => readTaskStoreState(view.stores.todos as never)).not.toThrow();
    });

    it('never lets two lanes mint the same record id', () => {
        const view = emptyCanonicalView();
        const identity = createIdentityLedger({ 'record:todos': 1 });

        const first = applySharedMutation(
            view,
            { kind: 'record:add', store: 'todos', record: { text: 'from lane A', completed: false } },
            { laneEpoch: EPOCH_A, leases: createWriterLeaseLedger(), identity, opId: 0, seq: 1 }
        );
        const second = applySharedMutation(
            view,
            { kind: 'record:add', store: 'todos', record: { text: 'from lane B', completed: false } },
            { laneEpoch: EPOCH_B, leases: createWriterLeaseLedger(), identity, opId: 0, seq: 1 }
        );

        expect(first.status).toBe('applied');
        expect(second.status).toBe('applied');
        expect(view.stores.todos.items.map((item) => item.id)).toEqual(['2', '3']);
        expect(view.stores.todos.items.map((item) => item.text)).toEqual(['from lane A', 'from lane B']);
    });

    it('reproduces the lost update: a concurrent edit is REFUSED with the canonical digest, not overwritten', () => {
        const view = emptyCanonicalView();
        const identity = createIdentityLedger({ 'record:todos': 1 });
        const leases = createWriterLeaseLedger();

        applySharedMutation(
            view,
            { kind: 'record:add', store: 'todos', record: { text: 'shared', completed: false } },
            { laneEpoch: EPOCH_A, leases, identity, opId: 0, seq: 1 }
        );

        const created = view.stores.todos.items[0];
        const readDigest = expectsDigestOf(created);

        // Lane B renames it first.
        const bWins = applySharedMutation(
            view,
            { kind: 'record:update', store: 'todos', id: created.id, patch: { text: 'lane B won' }, expects: readDigest },
            { laneEpoch: EPOCH_B, leases, identity, opId: 1, seq: 1 }
        );

        expect(bWins.status).toBe('applied');

        // Lane A, still holding the digest it read, must not silently overwrite B.
        const aLoses = applySharedMutation(
            view,
            { kind: 'record:update', store: 'todos', id: created.id, patch: { completed: true }, expects: readDigest },
            { laneEpoch: EPOCH_A, leases, identity, opId: 2, seq: 1 }
        );

        expect(aLoses.status).toBe('rejected');
        expect(aLoses.rejection?.code).toBe('stale-record');
        expect(aLoses.effect?.digest).toBe(expectsDigestOf(view.stores.todos.items[0]));
        // B's text is intact; A's patch is not applied at all (the lane re-reads and
        // re-applies against the new value).
        expect(view.stores.todos.items[0].text).toBe('lane B won');
        expect(view.stores.todos.items[0].completed).toBe(false);

        // With the fresh digest, A's change lands and nothing is lost.
        const aRetries = applySharedMutation(
            view,
            {
                kind: 'record:update',
                store: 'todos',
                id: created.id,
                patch: { completed: true },
                expects: expectsDigestOf(view.stores.todos.items[0])
            },
            { laneEpoch: EPOCH_A, leases, identity, opId: 3, seq: 2 }
        );

        expect(aRetries.status).toBe('applied');
        expect(view.stores.todos.items[0]).toEqual({ id: created.id, text: 'lane B won', completed: true });
    });

    it('refuses a removal or update of a record that is gone', () => {
        const view = emptyCanonicalView();
        const identity = createIdentityLedger({ 'record:todos': 1 });
        const leases = createWriterLeaseLedger();

        const removed = applySharedMutation(
            view,
            { kind: 'record:remove', store: 'todos', id: '9', expects: expectsDigestOf(undefined) },
            { laneEpoch: EPOCH_A, leases, identity, opId: 0, seq: 1 }
        );

        expect(removed.rejection?.code).toBe('unknown-record');
        expect(applySharedMutation(view, { kind: 'record:add', store: 'ghosts', record: {} } as never, { laneEpoch: EPOCH_A, leases, identity, opId: 0, seq: 1 }).rejection?.code).toBe(
            'unknown-store'
        );
    });

    // T1: the block a lane folds against is the CORE's persisted task store, and from
    // T1 on that block carries `rev` + attribution per record and `storeRev` + the
    // change feed per store. Two things have to stay true: the folded store is still
    // valid to `readTaskStoreState` (a session that restores it must not choke), and
    // the fold's DIGEST guard still sees every one of those fields - which is exactly
    // how it differs from the tool's `{ id, rev }` compare-and-swap (a claim moves the
    // record but never the content revision).
    it('folds a T1 task store without breaking the core validator', () => {
        const view = emptyCanonicalView();
        const todos = view.stores.todos as unknown as {
            items: Record<string, unknown>[];
            nextId: number;
            storeRev: number;
            changes: Record<string, unknown>[];
        };

        todos.items.push({
            id: '1',
            text: 'shared',
            completed: false,
            rev: 1,
            updatedBy: 'primary',
            updatedAt: EPOCH_ISO
        });
        todos.nextId = 2;
        todos.storeRev = 2;
        todos.changes = [
            {
                rev: 1,
                id: '1',
                op: 'add',
                by: 'primary',
                at: EPOCH_ISO,
                itemRev: 1
            },
            {
                rev: 2,
                id: '1',
                op: 'claim',
                by: 'primary',
                at: EPOCH_ISO
            }
        ];

        expect(() => readTaskStoreState(todos as never)).not.toThrow();

        // Nothing is dropped on the way through the validator: the revision, the
        // attribution and the feed window all come back, in the canonical key order.
        expect(readTaskStoreState(todos as never)).toEqual({
            items: [
                {
                    id: '1',
                    text: 'shared',
                    completed: false,
                    rev: 1,
                    updatedBy: 'primary',
                    updatedAt: EPOCH_ISO
                }
            ],
            nextId: 2,
            storeRev: 2,
            changes: [
                { rev: 1, id: '1', op: 'add', by: 'primary', at: EPOCH_ISO, itemRev: 1 },
                { rev: 2, id: '1', op: 'claim', by: 'primary', at: EPOCH_ISO }
            ]
        });
    });

    it('digests the T1 fields, which the tool-level content revision deliberately ignores', () => {
        const view = emptyCanonicalView();
        const identity = createIdentityLedger({ 'record:todos': 1 });
        const leases = createWriterLeaseLedger();

        applySharedMutation(
            view,
            { kind: 'record:add', store: 'todos', record: { text: 'shared', completed: false, rev: 1 } },
            { laneEpoch: EPOCH_A, leases, identity, opId: 0, seq: 1 }
        );

        const readDigest = expectsDigestOf(view.stores.todos.items[0]);

        // First the ordinary case, as a baseline: the lane holds the digest it really
        // read, so its patch lands.
        const appliedFirst = applySharedMutation(
            view,
            {
                kind: 'record:update',
                store: 'todos',
                id: view.stores.todos.items[0].id,
                patch: { completed: true },
                expects: readDigest
            },
            { laneEpoch: EPOCH_B, leases, identity, opId: 1, seq: 1 }
        );

        expect(appliedFirst.status).toBe('applied');

        // A CLAIM bumps no content revision, so the tool's `{ id, rev }` token stays
        // valid - but the stored record DID change, and the fold's digest covers the
        // whole value. Applying the claim to the fold view is what a routed core claim
        // does to the next folded snapshot, so this is the realistic concurrent case.
        const claimed = {
            ...view.stores.todos.items[0],
            owner: 'lane-a',
            leaseUntil: EPOCH_MS + TASK_DEFAULT_LEASE_MS
        };

        view.stores.todos.items[0] = claimed;

        expect(expectsDigestOf(claimed)).not.toBe(readDigest);

        const refused = applySharedMutation(
            view,
            {
                kind: 'record:update',
                store: 'todos',
                id: claimed.id,
                patch: { text: 'written over a claim' },
                expects: readDigest
            },
            { laneEpoch: EPOCH_B, leases, identity, opId: 2, seq: 1 }
        );

        // Refused by the FOLD (a `stale-record` receipt carrying the canonical digest),
        // which is a different mechanism from the canonical store throwing the tool's
        // CAS sentence. See ./lane-authority.test.ts for that side.
        expect(refused.status).toBe('rejected');
        expect(refused.rejection?.code).toBe('stale-record');
        expect(refused.effect?.digest).toBe(expectsDigestOf(claimed));

        // With the digest of the claimed record, the same patch lands and keeps the T1
        // fields the core owns - the fold never strips `owner`/`leaseUntil`.
        const applied = applySharedMutation(
            view,
            {
                kind: 'record:update',
                store: 'todos',
                id: claimed.id,
                patch: { text: 'written over a claim' },
                expects: expectsDigestOf(claimed)
            },
            { laneEpoch: EPOCH_B, leases, identity, opId: 3, seq: 1 }
        );

        expect(applied.status).toBe('applied');
        expect(view.stores.todos.items[0]).toEqual({
            ...claimed,
            text: 'written over a claim'
        });
    });
});

describe('transcript ops: append-safe, leased, and never an overwrite', () => {
    it('appends at the length the lane observed, and reports the canonical length when that moved', () => {
        const view = viewWith('thread-1');
        const leases = claiming(EPOCH_A, 'thread-1');
        const identity = createIdentityLedger({ thread: 1 });

        const first = applySharedMutation(
            view,
            { kind: 'transcript:append', threadId: 'thread-1', fromLength: 0, messages: [{ role: 'user', content: 'lane a' }] },
            { laneEpoch: EPOCH_A, leases, identity, opId: 0, seq: 1 }
        );

        expect(first).toEqual({
            opId: 0,
            seq: 1,
            laneEpoch: EPOCH_A,
            status: 'applied',
            effect: { length: 1, digest: first.effect?.digest }
        });

        // A second writer into the SAME conversation that still believes the prefix is
        // empty is refused - it must re-read, and then its text lands after the first.
        const stale = applySharedMutation(
            view,
            { kind: 'transcript:append', threadId: 'thread-1', fromLength: 0, messages: [{ role: 'user', content: 'lane b' }] },
            { laneEpoch: EPOCH_B, leases: claiming(EPOCH_B, 'thread-1'), identity, opId: 1, seq: 1 }
        );

        expect(stale.status).toBe('rejected');
        expect(stale.rejection?.code).toBe('prefix-moved');
        expect(stale.effect?.length).toBe(1);

        const rebased = applySharedMutation(
            view,
            { kind: 'transcript:append', threadId: 'thread-1', fromLength: 1, messages: [{ role: 'user', content: 'lane b' }] },
            { laneEpoch: EPOCH_B, leases: claiming(EPOCH_B, 'thread-1'), identity, opId: 2, seq: 1 }
        );

        expect(rebased.status).toBe('applied');
        expect(view.threads['thread-1'].messages.map((message) => (message as { content: string }).content)).toEqual([
            'lane a',
            'lane b'
        ]);
    });

    it('reproduces F6: a lane may not write a conversation it does not own, and says so', () => {
        const view = viewWith('thread-1');
        const identity = createIdentityLedger({ thread: 1 });

        const intruder = applySharedMutation(
            view,
            { kind: 'transcript:append', threadId: 'thread-1', fromLength: 0, messages: [{ role: 'user', content: 'not mine' }] },
            { laneEpoch: EPOCH_B, leases: claiming(EPOCH_A, 'thread-1'), identity, opId: 0, seq: 1 }
        );

        expect(intruder.status).toBe('rejected');
        expect(intruder.rejection?.code).toBe('not-writer');
        expect(intruder.rejection?.message).toBe(
            'Lane 2 may not write thread:thread-1; the writer lease is held by lane 1. Claim it, or run the conversation as its own child thread.'
        );
        // And the rejection is not a silent filter: the state never moved.
        expect(view.threads['thread-1'].messages).toHaveLength(0);
    });

    it('reproduces F5: one agent default conversation has exactly one writer', () => {
        const view: CanonicalView = {
            ...emptyCanonicalView(),
            threads: {
                'agent:research': { id: 'agent:research', agent: 'research', status: 'idle', sequence: 0, messages: [] }
            }
        };
        const identity = createIdentityLedger({ thread: 1 });

        expect(leaseKeyOf(leaseScopeOf({ kind: 'transcript:append', threadId: 'agent:research', fromLength: 0, messages: [] }, view)!)).toBe(
            'agent:research'
        );

        const leases = createWriterLeaseLedger();

        expect(leases.claim({ kind: 'agent', name: 'research' }, EPOCH_A)).toEqual({ ok: true });
        // Lane B delegating to the same shared brain is refused; it takes a child.
        expect(leases.claim({ kind: 'agent', name: 'research' }, EPOCH_B)).toEqual({ ok: false, holder: EPOCH_A });

        const blocked = applySharedMutation(
            view,
            { kind: 'transcript:append', threadId: 'agent:research', fromLength: 0, messages: [{ role: 'user', content: 'lane b subagent' }] },
            { laneEpoch: EPOCH_B, leases, identity, opId: 0, seq: 1 }
        );

        expect(blocked.rejection?.code).toBe('not-writer');

        const allowed = applySharedMutation(
            view,
            { kind: 'transcript:append', threadId: 'agent:research', fromLength: 0, messages: [{ role: 'user', content: 'lane a subagent' }] },
            { laneEpoch: EPOCH_A, leases, identity, opId: 0, seq: 1 }
        );

        expect(allowed.status).toBe('applied');
    });

    it('refuses an unknown thread and an oversized transcript', () => {
        const view = viewWith('thread-1');
        const leases = claiming(EPOCH_A, 'thread-1');
        const identity = createIdentityLedger({ thread: 1 });

        expect(
            applySharedMutation(
                view,
                { kind: 'transcript:append', threadId: 'thread-9', fromLength: 0, messages: [] },
                { laneEpoch: EPOCH_A, leases, identity, opId: 0, seq: 1 }
            ).rejection?.code
        ).toBe('unknown-thread');

        const huge: SharedMutation = {
            kind: 'transcript:append',
            threadId: 'thread-1',
            fromLength: 0,
            messages: Array.from({ length: DEFAULT_BOUNDS.maxMessagesPerThread + 1 }, (_, index) => ({
                role: 'user',
                content: String(index)
            })) as never
        };

        expect(
            applySharedMutation(view, huge, { laneEpoch: EPOCH_A, leases, identity, opId: 1, seq: 1 }).rejection?.code
        ).toBe('capacity-transcript');
    });
});

describe('thread creation and result archiving: identity comes from the authority', () => {
    it('mints a child thread id and gives its writer lease to the creating lane', () => {
        const view = emptyCanonicalView();
        const leases = createWriterLeaseLedger();
        const identity = createIdentityLedger({ thread: 1 });

        const created = applySharedMutation(
            view,
            { kind: 'thread:create', agent: 'research', ownerThreadId: 'thread-1' },
            { laneEpoch: EPOCH_A, leases, identity, opId: 0, seq: 1 }
        );

        expect(created.effect?.mintedId).toBe('thread-2');
        expect(leases.holderOf({ kind: 'thread', id: 'thread-2' })).toBe(EPOCH_A);
        expect(view.threads['thread-2']).toEqual({
            id: 'thread-2',
            agent: 'research',
            status: 'idle',
            sequence: 2,
            ownerThreadId: 'thread-1',
            messages: []
        });
    });

    it('reproduces F2: two lanes each archive their own result, and a duplicate id is refused', () => {
        const view = emptyCanonicalView();
        const identity = createIdentityLedger({ invocation: 1 });

        const archiveFor = (laneEpoch: number, content: string, invocationId: string) =>
            applySharedMutation(
                view,
                {
                    kind: 'result:archive',
                    invocationId,
                    sequence: Number(invocationId),
                    completedOrder: Number(invocationId),
                    agent: 'instruct',
                    role: 'primary',
                    runKind: 'root',
                    status: 'completed',
                    content
                },
                { laneEpoch, leases: createWriterLeaseLedger(), identity, opId: 0, seq: 1 }
            );

        const idA = identity.allocate('invocation', 1, EPOCH_A);
        const idB = identity.allocate('invocation', 1, EPOCH_B);

        if (!idA.ok || !idB.ok) throw new Error('unexpected exhaustion');

        expect(archiveFor(EPOCH_A, 'answer from lane A', String(idA.lease.start)).status).toBe('applied');
        expect(archiveFor(EPOCH_B, 'answer from lane B', String(idB.lease.start)).status).toBe('applied');
        // The reviewer saw both lanes mint `1` and one answer disappear.
        expect(Object.values(view.results).map((result) => result.content)).toEqual([
            'answer from lane A',
            'answer from lane B'
        ]);

        // T10 finding M3: a repeat of an id THIS lane already archived is not a collision, it
        // is the same conversation's next turn (a host thread's invocation id IS its thread id).
        // It replaces the slot, exactly as the core's id-keyed archive does inline.
        const sameWriter = archiveFor(EPOCH_A, 'lane A second turn', String(idA.lease.start));

        expect(sameWriter.status).toBe('applied');
        expect(view.results[String(idA.lease.start)].content).toBe('lane A second turn');
        expect(Object.keys(view.results)).toHaveLength(2);

        // A DIFFERENT live epoch claiming that id is a real collision, and the canonical digest
        // travels back so the losing lane stops re-sending an identity it does not hold.
        const collision = archiveFor(EPOCH_B, 'lane B invented the same id', String(idA.lease.start));

        expect(collision.status).toBe('rejected');
        expect(collision.rejection?.code).toBe('not-writer');
        expect(collision.rejection?.message).toBe(
            `Invocation "${String(idA.lease.start)}" is archived by lane ${EPOCH_A}; this lane (${EPOCH_B}) does not own that identity.`
        );
        expect(collision.effect?.digest).toBe(archiveDigestOf(view.results[String(idA.lease.start)]));
        // The refusal moved nothing.
        expect(view.results[String(idA.lease.start)].content).toBe('lane A second turn');
        // Ownership is recorded where the write landed, so the fold can tell the two cases apart.
        expect(view.resultOwners[String(idA.lease.start)]).toBe(EPOCH_A);
    });

    it('holds the core retention bound by evicting the oldest completed result', () => {
        const view = emptyCanonicalView();
        const identity = createIdentityLedger({ invocation: 1 });

        for (let index = 0; index < DEFAULT_BOUNDS.maxResults + 4; index += 1) {
            applySharedMutation(
                view,
                {
                    kind: 'result:archive',
                    invocationId: String(index + 2),
                    sequence: index + 2,
                    completedOrder: index + 2,
                    agent: 'instruct',
                    role: 'primary',
                    runKind: 'root',
                    status: 'completed',
                    content: `answer ${index}`
                },
                { laneEpoch: EPOCH_A, leases: createWriterLeaseLedger(), identity, opId: index, seq: 1 }
            );
        }

        expect(Object.keys(view.results)).toHaveLength(DEFAULT_BOUNDS.maxResults);
        expect(view.results['2']).toBeUndefined();
        expect(view.results[String(DEFAULT_BOUNDS.maxResults + 5)].content).toBe('answer 67');
    });
});

describe('registry ops: the budget is authority-owned, and a change is broadcast', () => {
    it('reproduces F3: two lanes creating one tool each spend TWO budget units', () => {
        const view = emptyCanonicalView();
        const identity = createIdentityLedger();

        for (const [laneEpoch, name] of [
            [EPOCH_A, 'tool_a'],
            [EPOCH_B, 'tool_b']
        ] as const) {
            const created = applySharedMutation(
                view,
                { kind: 'tool:create', name, source: 'export const execute = () => 1;', revision: `rev-${name}` },
                { laneEpoch, leases: createWriterLeaseLedger(), identity, opId: 0, seq: 1 }
            );

            expect(created.status).toBe('applied');
            // Every accepted registration is broadcast, so no other replica keeps
            // running the previous definition (F9/F10).
            expect(created.effect?.broadcast).toEqual({ name, source: 'export const execute = () => 1;', revision: `rev-${name}`, removed: false });
        }

        expect(Object.keys(view.tools)).toEqual(['tool_a', 'tool_b']);
        // The old merge published max(1, 1) = 1, refunding one creation.
        expect(view.createdToolCount).toBe(2);
    });

    it('stops at the lifetime budget and never lets a replacement consume it', () => {
        const view = emptyCanonicalView();
        const identity = createIdentityLedger();
        const leases = createWriterLeaseLedger();

        for (let index = 0; index < DEFAULT_BOUNDS.maxCreatedTools; index += 1) {
            applySharedMutation(
                view,
                { kind: 'tool:create', name: `tool_${index}`, source: 'x', revision: `r${index}` },
                { laneEpoch: EPOCH_A, leases, identity, opId: index, seq: 1 }
            );
        }

        const overBudget = applySharedMutation(
            view,
            { kind: 'tool:create', name: 'one_more', source: 'x', revision: 'r' },
            { laneEpoch: EPOCH_A, leases, identity, opId: 99, seq: 2 }
        );

        expect(overBudget.rejection).toEqual({
            code: 'capacity-tools',
            message: `This session has spent its lifetime budget of ${DEFAULT_BOUNDS.maxCreatedTools} created tools.`
        });

        const replaced = applySharedMutation(
            view,
            { kind: 'tool:replace', name: 'tool_0', source: 'y', revision: 'r0-new', expects: 'r0' },
            { laneEpoch: EPOCH_A, leases, identity, opId: 100, seq: 3 }
        );

        expect(replaced.status).toBe('applied');
        expect(view.createdToolCount).toBe(DEFAULT_BOUNDS.maxCreatedTools);
    });

    it('refuses a replacement written against a revision somebody else installed', () => {
        const view = emptyCanonicalView();
        const identity = createIdentityLedger();

        applySharedMutation(
            view,
            { kind: 'tool:create', name: 'shared', source: 'v1', revision: 'r1' },
            { laneEpoch: EPOCH_A, leases: createWriterLeaseLedger(), identity, opId: 0, seq: 1 }
        );

        const other = applySharedMutation(
            view,
            { kind: 'tool:replace', name: 'shared', source: 'v2', revision: 'r2', expects: 'r1' },
            { laneEpoch: EPOCH_B, leases: createWriterLeaseLedger(), identity, opId: 1, seq: 1 }
        );

        expect(other.status).toBe('applied');

        const stale = applySharedMutation(
            view,
            { kind: 'tool:replace', name: 'shared', source: 'v3', revision: 'r3', expects: 'r1' },
            { laneEpoch: EPOCH_A, leases: createWriterLeaseLedger(), identity, opId: 2, seq: 1 }
        );

        expect(stale.rejection?.code).toBe('stale-tool');
        expect(stale.effect?.digest).toBe('r2');
        expect(view.tools.shared.revision).toBe('r2');
    });
});

describe('memory ops: CAS against the authority, bounded to what the lane read', () => {
    it('refuses a write whose expected value has moved, and hands back the digest', () => {
        const view = emptyCanonicalView();

        view.memory.cache = { from: 'lane A' };

        const readDigest = expectsDigestOf(view.memory.cache);

        view.memory.cache = { from: 'lane B' };

        const stale = applySharedMutation(
            view,
            { kind: 'memory:set', key: 'cache', value: { from: 'lane A again' }, expects: readDigest },
            { laneEpoch: EPOCH_A, leases: createWriterLeaseLedger(), identity: createIdentityLedger(), opId: 0, seq: 1 }
        );

        expect(stale.status).toBe('rejected');
        expect(stale.rejection?.code).toBe('stale-memory');
        expect(stale.effect?.digest).toBe(expectsDigestOf({ from: 'lane B' }));
        expect(view.memory.cache).toEqual({ from: 'lane B' });
    });

    it('names a key that cannot cross the boundary instead of dropping it (F4)', () => {
        const view = emptyCanonicalView();

        const rejected = applySharedMutation(
            view,
            { kind: 'memory:set', key: 'handler', value: () => 'closure', expects: expectsDigestOf(undefined) },
            { laneEpoch: EPOCH_A, leases: createWriterLeaseLedger(), identity: createIdentityLedger(), opId: 0, seq: 1 }
        );

        expect(rejected.rejection?.code).toBe('memory-untransferable');
        expect(rejected.rejection?.message).toBe(
            'harness.memory["handler"] holds a function (a function is local to one thread); use a cloneable value or run this session with threadExecution "inline".'
        );
        expect('handler' in view.memory).toBe(false);
    });

    it('reproduces the sibling-memory loss: a lane that never declared a key cannot delete it', () => {
        const memory: Record<string, unknown> = { 'noteSearch.cache': [1, 2] };
        const laneDeclared: string[] = [];

        // The old design re-projected memory from a base the lane had never been
        // given, and emitted `removed: ["noteSearch.cache"]`.
        for (const key of laneDeclared) {
            expect(Object.keys(memory)).toContain(key);
        }

        expect(laneDeclared).toEqual([]);
        // The sibling key survives because no declared write touched it.
        expect(memory['noteSearch.cache']).toEqual([1, 2]);
    });
});

describe('mutation groups and the journal', () => {
    const group = (seq: number, ops: SharedMutation[], laneEpoch = EPOCH_A): MutationGroup => ({ laneEpoch, seq, ops });

    it('applies a whole group atomically, and rolls back when one op is refused', () => {
        const view = emptyCanonicalView();
        const leases = createWriterLeaseLedger();
        const identity = createIdentityLedger({ 'record:todos': 1 });

        const added = applySharedMutation(
            view,
            { kind: 'record:add', store: 'todos', record: { text: 'kept', completed: false } },
            { laneEpoch: EPOCH_A, leases, identity, opId: 0, seq: 1 }
        );

        expect(added.status).toBe('applied');

        const before = JSON.stringify(view);

        const outcome = applyMutationGroup(
            view,
            group(2, [
                { kind: 'record:add', store: 'todos', record: { text: 'in the failed group', completed: false } },
                { kind: 'record:update', store: 'todos', id: 'does-not-exist', patch: { text: 'x' }, expects: 'whatever' }
            ]),
            { laneEpoch: EPOCH_A, leases, identity }
        );

        expect(outcome.outcome.status).toBe('partial');
        expect(outcome.outcome.complete).toBe(false);
        expect(outcome.view).toBe(view);
        expect(JSON.stringify(view)).toBe(before);
        expect(outcome.outcome.receipts.map((receipt) => receipt.status)).toEqual(['applied', 'rejected']);
    });

    it('keeps the canonical view untouched for an over-large group', () => {
        const view = emptyCanonicalView();
        const huge = group(1, Array.from({ length: 65 }, () => ({ kind: 'discovery:enable', names: ['read'] }) as SharedMutation));

        const outcome = applyMutationGroup(view, huge, {
            laneEpoch: EPOCH_A,
            leases: createWriterLeaseLedger(),
            identity: createIdentityLedger()
        });

        expect(outcome.outcome.receipts).toHaveLength(65);
        expect(outcome.outcome.receipts[0].rejection?.code).toBe('invalid-mutation');
        expect(outcome.view.discovery.enabled).toEqual([]);
    });

    it('applies a complete group and moves the applied watermark exactly to its seq', () => {
        const view = emptyCanonicalView();
        const journal = createCommitJournal();

        journal.open(EPOCH_A);

        const outcome = applyMutationGroup(
            view,
            group(1, [{ kind: 'discovery:enable', names: ['read'] }]),
            { laneEpoch: EPOCH_A, leases: createWriterLeaseLedger(), identity: createIdentityLedger() }
        );

        journal.settle(EPOCH_A, 1, outcome.outcome.complete);

        expect(outcome.outcome.complete).toBe(true);
        expect(journal.appliedThrough(EPOCH_A)).toBe(1);
        expect(journal.accepts(EPOCH_A, 1)).toEqual({ ok: false, code: 'seq-duplicate' });
        expect(journal.accepts(EPOCH_A, 2)).toEqual({ ok: true });
    });

    it('reproduces F7/F8: a rejected group never advances the base, so success cannot be published', () => {
        const journal = createCommitJournal();

        journal.open(EPOCH_A);

        journal.settle(EPOCH_A, 1, false);

        expect(journal.appliedThrough(EPOCH_A)).toBe(0);
        expect(journal.mayPublishSuccess(EPOCH_A, 1)).toBe(false);

        journal.settle(EPOCH_A, 2, true);

        expect(journal.mayPublishSuccess(EPOCH_A, 1)).toBe(true);
        expect(journal.mayPublishSuccess(EPOCH_A, 2)).toBe(true);
        expect(journal.mayPublishSuccess(EPOCH_A, 3)).toBe(false);
    });

    it('refuses late frames from a superseded epoch, and a group behind the watermark', () => {
        const journal = createCommitJournal();

        journal.open(EPOCH_A);
        journal.settle(EPOCH_A, 5, true);

        expect(journal.accepts(EPOCH_A, 6)).toEqual({ ok: true });

        // The lane stopped and restarted: the old epoch is dead, and only the new one
        // may move state.
        replaceLaneEpoch(journal, EPOCH_A, EPOCH_B);

        expect(journal.accepts(EPOCH_A, 6)).toEqual({ ok: false, code: 'epoch-superseded' });
        expect(journal.accepts(EPOCH_A, 99)).toEqual({ ok: false, code: 'epoch-superseded' });
        expect(journal.accepts(EPOCH_B, 1)).toEqual({ ok: true });
        expect(journal.appliedThrough(EPOCH_B)).toBe(0);

        // An epoch the coordinator never opened is dead by definition, and seq 0 is
        // below every watermark.
        expect(journal.accepts(4_242, 1)).toEqual({ ok: false, code: 'epoch-superseded' });
        expect(journal.accepts(EPOCH_B, 0)).toEqual({ ok: false, code: 'seq-behind' });
        expect(journal.mayPublishSuccess(EPOCH_B, 0)).toBe(true);
        expect(journal.mayPublishSuccess(EPOCH_B, 1)).toBe(false);
    });
});

// T10 findings M2, M3 and S6: what a boundary reports, and what a lane is therefore allowed
// to believe. The retired behaviour was: the fold rolled back, the LIVE applier replayed the
// individually-applied receipts anyway, and the lane adopted nothing from an incomplete group
// - so canonical and the lane's base diverged permanently, one contested key wedged every
// later commit of that lane, and the turn could never publish.
describe('group rollback, canonical re-base, and the declared window (T10 M2/M3/S6)', () => {
    const groupFor = (seq: number, ops: SharedMutation[], laneEpoch = EPOCH_A): MutationGroup => ({ laneEpoch, seq, ops });

    const contested = () => {
        const view = viewWith('thread-3', [{ role: 'user', content: 'q' }]);
        const leases = createWriterLeaseLedger();

        leases.claim({ kind: 'thread', id: 'thread-3' }, EPOCH_A);

        const folded = applyMutationGroup(
            view,
            groupFor(1, [
                // A key both lanes read as absent: this one wins, the other is refused.
                { kind: 'memory:set', key: 'shared.cache', value: 'from-A', expects: expectsDigestOf(undefined) },
                // A stale prefix: canonical holds 1 message, the lane appends at 0.
                { kind: 'transcript:append', threadId: 'thread-3', fromLength: 0, messages: [{ role: 'assistant', content: 'a' }] }
            ]),
            { laneEpoch: EPOCH_A, leases, identity: createIdentityLedger({ thread: 3 }) }
        );

        return { view, folded };
    };

    it('rolls the staged view back and hands the caller the SAME view object', () => {
        const { view, folded } = contested();

        expect(folded.outcome.status).toBe('partial');
        expect(folded.outcome.complete).toBe(false);
        expect(folded.view).toBe(view);
        expect(view.memory['shared.cache']).toBeUndefined();
        expect(view.threads['thread-3'].messages).toHaveLength(1);
    });

    it('rewrites every would-have-applied receipt into a refusal with no effect (M2)', () => {
        const { folded } = contested();
        const rolled = rolledBackReceipts(folded.outcome.receipts, folded.outcome.receipts.map(() => ({ kind: 'memory:set', key: 'k', value: 1, expects: 'x' }) as SharedMutation), EPOCH_A, 1);

        // Staged receipts say `applied` for op 0; the live applier must not treat them as such.
        expect(folded.outcome.receipts.map((receipt) => receipt.status)).toEqual(['applied', 'rejected']);
        expect(rolled.map((receipt) => receipt.status)).toEqual(['rejected', 'rejected']);
        expect(rolled[0].rejection?.code).toBe('group-rolled-back');
        expect(rolled[0].effect).toBeUndefined();
        // The refusal that CAUSED the rollback keeps its canonical facts, which is what lets
        // the lane re-base instead of repeating the same boundary forever.
        expect(rolled[1].rejection?.code).toBe('prefix-moved');
        expect(rolled[1].effect?.length).toBe(1);
    });

    it('digests an archived result over the writer-owned fields only (M3)', () => {
        const record = {
            invocationId: 'thread-3',
            sequence: 7,
            completedOrder: 1,
            agent: 'instruct',
            role: 'primary',
            kind: 'root',
            status: 'completed',
            content: 'answer one'
        };

        // The authority reassigns `completedOrder` on every apply, so a digest that covered it
        // would never match the lane's own view and the lane would re-archive forever.
        expect(archiveDigestOf(record)).toBe(archiveDigestOf({ ...record, completedOrder: 99 }));
        expect(archiveDigestOf(record)).not.toBe(archiveDigestOf({ ...record, content: 'answer two' }));
        expect(archiveDigestOf(record)).not.toBe(archiveDigestOf({ ...record, sequence: 9 }));
    });

    it('refuses a memory write the lane was never given a window for (S6)', () => {
        const view = emptyCanonicalView();

        view.memory['sibling.key'] = 'canonical value';

        const write = { kind: 'memory:set', key: 'sibling.key', value: 'lane value', expects: expectsDigestOf(undefined) } as SharedMutation;

        const refused = applySharedMutation(view, write, {
            ...context(view),
            declaredKeys: ['mine.key']
        });

        expect(refused.status).toBe('rejected');
        expect(refused.rejection?.code).toBe('memory-undeclared');
        // The canonical digest comes back so the lane re-bases rather than guessing again.
        expect(refused.effect?.digest).toBe(expectsDigestOf('canonical value'));
        expect(view.memory['sibling.key']).toBe('canonical value');

        const removed = applySharedMutation(view, { kind: 'memory:delete', key: 'sibling.key', expects: expectsDigestOf(undefined) }, {
            ...context(view),
            declaredKeys: ['mine.key']
        });

        expect(removed.rejection?.code).toBe('memory-undeclared');
        expect(view.memory['sibling.key']).toBe('canonical value');

        // A session that declares no window at all stays unrestricted - the same reading
        // ./lane-authority.ts uses for a `memory:window` request. The CAS check still applies,
        // which is the point: the window rule and the digest rule are separate guards.
        const allowed = applySharedMutation(view, { kind: 'memory:set', key: 'sibling.key', value: 'lane value', expects: expectsDigestOf('canonical value') }, {
            ...context(view),
            declaredKeys: undefined
        });

        expect(allowed.status).toBe('applied');
        expect(view.memory['sibling.key']).toBe('lane value');
    });
});

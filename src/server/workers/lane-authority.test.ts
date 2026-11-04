// The authority: the coordinator-side applier and router, tested against a REAL harness
// (not a mock), because every case below is a claim about canonical session state.
//
// What these tests pin, in the reviewer's terms:
//   - a lane transcript append lands in the canonical conversation, and a stale prefix is
//     REFUSED with the canonical length instead of overwriting (T3 F5/F6);
//   - an unleased lane may not write a conversation at all (`not-writer`), so a second
//     delegator cannot write behind the owner (T3 F5);
//   - a committed terminal invocation becomes addressable through the core's OWN
//     agentManage/agentResult reader (the archive a lane produces is central), and the
//     completion ORDER is the authority's, never the lane's guess (T3 F2);
//   - memory commits are compare-and-set against the canonical map: a stale digest is
//     refused and the canonical digest comes back (T3 F4/F7);
//   - routed `runtime` operations mutate the canonical store with a core-minted id (the
//     central task mutation worker mode promises), and a cross-thread send from a lane
//     appends into the target conversation (D2 linearizable reads at a committed boundary);
//   - a retired epoch changes nothing, ever (T3 F9);
//   - the identity ledger is seeded with the CORE's units, so a lease can never mint an id
//     that makes a snapshot invalid (T3 F1).
//
// Cross-references:
//   - ./lane-authority.ts              - the module under test
//   - ../../harness.ts                 - appendThreadMessages / setThreadStatus /
//                                        archiveInvocation / reserveIdentity (the seams)
//   - ../sessions.ts                   - the caller that owns one authority per session
//   - ../../../Temp/t5/probe-seams.ts  - the seam probe these expectations came from

import { describe, expect, it } from 'vitest';
import { agent, harness } from '@underload/harness';
import type { Harness, HarnessStream, HarnessStreamEvent } from '@underload/harness';
import { canonicalViewOf, createLaneAuthority } from './lane-authority';
import { expectsDigestOf } from './lane-commit';
import type { MutationGroup } from './lane-commit';
import { ABSENT_DIGEST, digestMemoryValue } from './lane-memory';

// A scripted stream that never talks to a provider: the authority tests are about state,
// and a run here would only add latency.
const quiet = (): HarnessStream =>
    async function* (): AsyncGenerator<HarnessStreamEvent> {
        yield { type: 'text', delta: 'unused' };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };

const coreOf = (): Harness =>
    harness({
        agents: {
            primary: agent({ name: 'primary', model: 'm', instructions: 'Test primary.', stream: quiet() }),
            research: agent({ name: 'research', model: 'm', instructions: 'Test researcher.', stream: quiet() })
        },
        presets: false
    });

const EPOCH_A = 1;
const EPOCH_B = 2;

// An authority, opened the way ./lane-host.ts opens one.
//
// The journal refuses an epoch the coordinator never opened - only the coordinator opens
// epochs, so an unknown epoch can only mean "this lane is gone" - so every test that commits
// or answers must open its epoch first. Doing it here rather than auto-opening inside the
// authority keeps a lane lifecycle bug from being hidden by a convenient default.
const authorityFor = (
    core: Harness,
    options: Partial<Parameters<typeof createLaneAuthority>[0]> = {}
): ReturnType<typeof createLaneAuthority> => {
    const authority = createLaneAuthority({ harness: core, ...options });

    authority.openLane(EPOCH_A);
    authority.openLane(EPOCH_B);

    return authority;
};

const group = (seq: number, ops: MutationGroup['ops'], laneEpoch = EPOCH_A): MutationGroup => ({
    laneEpoch,
    seq,
    ops
});

describe('canonical view: built from the REAL snapshot, in the core units', () => {
    it('addresses the default conversation and a host thread by the ids a lane uses', () => {
        const core = coreOf();
        const thread = core.createThread('primary', { label: 'lane' });
        const view = canonicalViewOf(core, (core.memory as unknown as { data: Record<string, unknown> }).data);

        expect(Object.keys(view.threads).sort()).toEqual([thread.id, 'agent:primary', 'agent:research'].sort());
        expect(view.threads['agent:primary']).toMatchObject({ agent: 'primary', status: 'idle' });
        expect(view.threads[thread.id]).toMatchObject({ id: thread.id, agent: 'primary', label: 'lane', messages: [] });
        expect(view.memory).toBe((core.memory as unknown as { data: Record<string, unknown> }).data);
    });

    it('seeds identity from the store counters with the units converted (T3 F1)', () => {
        const core = coreOf();
        const authority = authorityFor(core);

        // An empty store publishes nextId 1, i.e. "nothing has been issued yet".
        expect(authority.ledger.watermarkOf('record:todos')).toBe(0);
        expect(authority.ledger.publishedOf('record:todos')).toBe(1);
        // The thread watermark is the highest existing thread sequence, in last-used units.
        expect(authority.ledger.watermarkOf('thread')).toBeGreaterThanOrEqual(1);
        expect(authority.ledger.publishedOf('thread')).toBe(authority.ledger.watermarkOf('thread'));
    });
});

describe('commit: the transcript append is the canonical conversation', () => {
    it('appends once and reports the canonical length', () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');

        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);

        const outcome = authority.commit(EPOCH_A, group(1, [
            {
                kind: 'transcript:append',
                threadId: thread.id,
                fromLength: 0,
                messages: [{ role: 'user', content: 'from the lane' }]
            }
        ]));

        expect(outcome.complete).toBe(true);
        expect(outcome.receipts[0].effect?.length).toBe(1);
        expect(core.threadMessages(thread.id).map((message) => (message as { content: string }).content)).toEqual([
            'from the lane'
        ]);
    });

    it('refuses a stale prefix and moves NOTHING (T3 F5)', () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');

        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);

        // The lane believes the conversation is empty; the authority already has a message
        // (the thread was created after a run, or a sibling wrote first).
        core.setThreadMessages(thread.id, [{ role: 'user', content: 'already here' }]);

        const outcome = authority.commit(EPOCH_A, group(1, [
            {
                kind: 'transcript:append',
                threadId: thread.id,
                fromLength: 0,
                messages: [{ role: 'assistant', content: 'lane guess' }]
            }
        ]));

        expect(outcome.complete).toBe(false);
        expect(outcome.receipts[0].status).toBe('rejected');
        expect(outcome.receipts[0].rejection?.code).toBe('prefix-moved');
        // The refusal carries the canonical length, which is what lets the lane re-read
        // instead of guessing.
        expect(outcome.receipts[0].effect?.length).toBe(1);
        expect(core.threadMessages(thread.id).map((message) => (message as { content: string }).content)).toEqual([
            'already here'
        ]);

        // Re-read at the canonical length and retry IN THE SAME LANE (the realistic case: the
        // append was refused, the lane re-read, and now its text lands). A second epoch cannot
        // take this conversation's writer lease while the owner still holds it - that is the
        // one-writer rule, not an accident.
        const retry = authority.commit(EPOCH_A, group(2, [
            {
                kind: 'transcript:append',
                threadId: thread.id,
                fromLength: 1,
                messages: [{ role: 'assistant', content: 'lane guess' }]
            }
        ]));

        expect(retry.complete).toBe(true);
        expect(retry.receipts[0].rejection).toBeUndefined();
        expect(core.threadMessages(thread.id).map((message) => (message as { content: string }).content)).toEqual([
            'already here',
            'lane guess'
        ]);

        // ...and a different lane is still refused, because the writer lease did not move.
        const secondWriter = authority.commit(EPOCH_B, group(1, [
            {
                kind: 'transcript:append',
                threadId: thread.id,
                fromLength: 2,
                messages: [{ role: 'user', content: 'a sibling tries' }]
            }
        ]));

        expect(secondWriter.complete).toBe(false);
        expect(secondWriter.receipts[0].rejection?.code).toBe('not-writer');
        expect(core.threadMessages(thread.id)).toHaveLength(2);
    });

    it('refuses a lane that does not own the conversation, naming the holder (T3 F6)', () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');

        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);

        const intruder = authority.commit(EPOCH_B, group(1, [
            {
                kind: 'transcript:append',
                threadId: thread.id,
                fromLength: 0,
                messages: [{ role: 'user', content: 'not the writer' }]
            }
        ]));

        expect(intruder.complete).toBe(false);
        expect(intruder.receipts[0].rejection?.code).toBe('not-writer');
        expect(core.threadMessages(thread.id)).toHaveLength(0);
    });
});

describe('commit: a lane terminal invocation is central', () => {
    it('archives so the core readers see it, with the authority owning the order', () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');

        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);

        const outcome = authority.commit(EPOCH_A, group(1, [
            {
                kind: 'result:archive',
                invocationId: thread.id,
                sequence: 7,
                completedOrder: 999,
                agent: 'primary',
                role: 'primary',
                runKind: 'root',
                status: 'completed',
                content: 'the lane answered'
            }
        ]));

        expect(outcome.complete).toBe(true);

        // The core's own reader, not a restatement of the input: the lane's answer is
        // addressable in the session, which is what `/results` and `agentResult` serve.
        const view = core.runtime.agentManage() as {
            agents: { name: string; results: { invocationId: string; status: string; contentLength: number }[] }[];
        };
        const primary = view.agents.find((entry) => entry.name === 'primary');

        expect(primary?.results.map((result) => result.invocationId)).toEqual([thread.id]);

        // `completedOrder: 999` was the LANE's local counter. The authority reassigns the
        // order, so two lanes cannot both claim to be "the latest finished" (T3 F2).
        const archived = core.snapshot().agentResults ?? [];

        expect(archived.find((record) => record.invocationId === thread.id)?.completedOrder).toBe(1);
        expect(archived.find((record) => record.invocationId === thread.id)?.sequence).toBe(7);
    });

    it('refuses an invocation for an agent this session does not have', () => {
        const core = coreOf();
        const authority = authorityFor(core);

        const outcome = authority.commit(EPOCH_A, group(1, [
            {
                kind: 'result:archive',
                invocationId: '7',
                sequence: 7,
                completedOrder: 1,
                agent: 'ghost',
                role: 'primary',
                runKind: 'root',
                status: 'completed',
                content: 'x'
            }
        ]));

        expect(outcome.complete).toBe(false);
        expect(core.snapshot().agentResults ?? []).toEqual([]);
    });
});

describe('commit: memory is compare-and-set against the canonical map', () => {
    it('applies a write that presents the digest the lane read', () => {
        const core = coreOf();
        const memory = (core.memory as unknown as { data: Record<string, unknown> }).data;

        memory['noteSearch.cache'] = [1, 2];

        const authority = authorityFor(core, { memoryKeys: ['noteSearch.cache'] });
        const read = digestMemoryValue(memory['noteSearch.cache']);

        const outcome = authority.commit(EPOCH_A, group(1, [
            { kind: 'memory:set', key: 'noteSearch.cache', value: [1, 2, 3], expects: read }
        ]));

        expect(outcome.complete).toBe(true);
        expect(core.memory.get('noteSearch.cache')).toEqual([1, 2, 3]);
    });

    it('refuses a stale digest, reports the canonical one, and keeps the sibling key (T3 F4)', () => {
        const core = coreOf();
        const memory = (core.memory as unknown as { data: Record<string, unknown> }).data;

        memory['lane.key'] = 'lane read this';
        memory['sibling.key'] = [7];

        const authority = authorityFor(core, { memoryKeys: ['lane.key', 'sibling.key'] });
        const stale = expectsDigestOf('a different value');

        const outcome = authority.commit(EPOCH_A, group(1, [
            { kind: 'memory:set', key: 'lane.key', value: 'lane wins?', expects: stale },
            { kind: 'memory:delete', key: 'sibling.key', expects: ABSENT_DIGEST }
        ]));

        expect(outcome.complete).toBe(false);
        expect(outcome.receipts[0].rejection?.code).toBe('stale-memory');
        // The canonical value survives, and its digest is what the lane is handed back.
        expect(core.memory.get('lane.key')).toBe('lane read this');
        expect(outcome.receipts[0].effect?.digest).toBe(digestMemoryValue('lane read this'));
        // A write that expected an ABSENT key on a key that EXISTS is refused too, so a
        // sibling's key is never deleted by a lane that raced it.
        expect(core.memory.get('sibling.key')).toEqual([7]);
    });

    it('names a value that cannot cross the boundary instead of dropping it', () => {
        const core = coreOf();
        const authority = authorityFor(core, { memoryKeys: ['handler'] });

        const outcome = authority.commit(EPOCH_A, group(1, [
            { kind: 'memory:set', key: 'handler', value: () => 'closure', expects: ABSENT_DIGEST }
        ]));

        expect(outcome.receipts[0].rejection?.code).toBe('memory-untransferable');
        expect(core.memory.has('handler')).toBe(false);
    });
});

describe('routed operations: the canonical harness performs the shared work', () => {
    it('mints a task record in the canonical store (the central mutation promise)', async () => {
        const core = coreOf();
        const authority = authorityFor(core);

        const first = await authority.answer(EPOCH_A, {
            op: 'runtime',
            method: 'executeRecordTool',
            name: 'task',
            parameters: { tasks: [{ text: 'from lane A' }] },
            identity: { agent: 'primary', threadId: 'thread-1', runDepth: 1 }
        });

        expect(JSON.stringify(first.value)).toContain('from lane A');

        // A DIFFERENT lane reads the same store: it sees the record with the id the core
        // minted, which is the whole point of routing instead of merging.
        const second = await authority.answer(EPOCH_B, {
            op: 'runtime',
            method: 'executeRecordTool',
            name: 'task',
            parameters: {},
            identity: { agent: 'primary', threadId: 'thread-2', runDepth: 1 }
        });

        expect(JSON.stringify(second.value)).toContain('from lane A');
        expect(JSON.stringify(second.value)).toContain('"id":"1"');

        // The ledger ADOPTED the id the core minted, so the next lease this session hands a
        // lane starts after it (T3 finding F1's collision, prevented at the source).
        expect(authority.ledger.publishedOf('record:todos')).toBe(2);
        expect(first.sync?.identities?.['record:todos']).toBe(1);
    });

    it('delivers a cross-thread message into the target conversation', async () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const target = core.createThread('research');

        const sent = await authority.answer(EPOCH_A, {
            op: 'runtime',
            method: 'threadSend',
            // `thread` is the TARGET and comes from the model (the tool's schema requires
            // it); `identity.threadId` is the SENDER's conversation, which the runtime -
            // never the model - supplies (src/harness.ts ~3337 states that rule).
            parameters: { thread: target.id, message: 'hello from a lane' },
            identity: { agent: 'primary', threadId: 'thread-1' }
        });

        expect(sent.value).toMatchObject({ threadId: target.id, delivered: 'appended', sender: 'primary' });

        // The delivered message is the core's own format (it attributes the sender inside the
        // text), so the assertion is containment, not an invented exact string.
        const delivered = core.threadMessages(target.id).map((message) => (message as { content: string }).content);

        expect(delivered).toHaveLength(1);
        expect(String(delivered[0])).toContain('hello from a lane');

        // The roster read is answered from the canonical state, so a lane never needs to
        // guess what conversations exist (decision D2).
        const roster = await authority.answer(EPOCH_A, {
            op: 'runtime',
            method: 'threadList',
            identity: { threadId: 'thread-1' }
        });

        expect((roster.value as { threads: { id: string }[] }).threads.map((thread) => thread.id)).toContain(target.id);
    });

    it('answers an id lease that keeps two lanes disjoint (T3 F2)', async () => {
        const core = coreOf();
        const authority = authorityFor(core);

        const a = await authority.answer(EPOCH_A, { op: 'lease', space: 'invocation', count: 8 });
        const b = await authority.answer(EPOCH_B, { op: 'lease', space: 'invocation', count: 8 });

        const leaseA = a.value as { start: number; count: number };
        const leaseB = b.value as { start: number; count: number };

        expect(leaseA.count).toBe(8);
        expect(leaseB.start).toBe(leaseA.start + leaseA.count);
        // Each answer carries the ledger watermark AT THAT MOMENT, in last-used units, so a
        // replica's reservation continues from the right place.
        expect(a.sync?.identities?.invocation).toBe(leaseA.start + leaseA.count - 1);
        expect(b.sync?.identities?.invocation).toBe(leaseB.start + leaseB.count - 1);
    });

    it('refuses a request from a retired epoch instead of answering it', async () => {
        const core = coreOf();
        const authority = authorityFor(core);

        authority.openLane(EPOCH_A);
        authority.closeLane(EPOCH_A);

        await expect(authority.answer(EPOCH_A, { op: 'runtime', method: 'listTools', identity: {} })).rejects.toThrow(
            /is retired; its requests are no longer answered/
        );
    });
});

describe('epoch lifecycle: a dead lane has no effects', () => {
    it('rejects a late commit and leaves canonical state untouched (T3 F9)', () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');

        authority.openLane(EPOCH_A, undefined);
        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);

        const live = authority.commit(EPOCH_A, group(1, [
            { kind: 'transcript:append', threadId: thread.id, fromLength: 0, messages: [{ role: 'user', content: 'kept' }] }
        ]));

        expect(live.complete).toBe(true);

        // The lane was replaced: its epoch dies, and the new epoch inherits the claim.
        authority.openLane(EPOCH_B, EPOCH_A);
        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_B);

        const late = authority.commit(EPOCH_A, group(2, [
            { kind: 'transcript:append', threadId: thread.id, fromLength: 1, messages: [{ role: 'user', content: 'too late' }] }
        ]));

        expect(late.status).toBe('rejected');
        expect(late.complete).toBe(false);
        expect(late.receipts[0].rejection?.code).toBe('epoch-superseded');
        expect(core.threadMessages(thread.id).map((message) => (message as { content: string }).content)).toEqual(['kept']);

        // The journal is what gates publishing: the new epoch has applied nothing yet, so a
        // turn claiming seq 1 may not be reported as done.
        expect(authority.journal.mayPublishSuccess(EPOCH_B, 1)).toBe(false);
        expect(authority.journal.mayPublishSuccess(EPOCH_A, 1)).toBe(true);
    });

    it('refuses a duplicate or a behind-watermark commit', () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');

        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);

        const op = (seq: number): MutationGroup =>
            group(seq, [
                {
                    kind: 'transcript:append',
                    threadId: thread.id,
                    fromLength: seq - 1,
                    messages: [{ role: 'user', content: `m${seq}` }]
                }
            ]);

        expect(authority.commit(EPOCH_A, op(1)).complete).toBe(true);
        expect(authority.commit(EPOCH_A, op(1)).receipts[0].rejection?.message).toContain('already settled');

        // A jump forward applies, and anything at or below the applied watermark is refused
        // as BEHIND: a lane never rewinds canonical state, and a re-sent group is a
        // duplicate, not a second application.
        expect(authority.commit(EPOCH_A, { laneEpoch: EPOCH_A, seq: 5, ops: [] }).complete).toBe(true);
        expect(authority.commit(EPOCH_A, op(3)).receipts[0].rejection?.message).toContain('behind');
        expect(authority.commit(EPOCH_A, op(2)).receipts[0].rejection?.message).toContain('behind');
        expect(core.threadMessages(thread.id)).toHaveLength(1);
    });
});

describe('canonical helpers the host drives', () => {
    it('reports the committed length for both conversation kinds', () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');

        core.setThreadMessages(thread.id, [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }]);

        expect(authority.canonicalLengthOf(thread.id)).toBe(2);
        expect(authority.canonicalLengthOf('agent:primary')).toBe(core.agents.primary.messages.length);
    });

    it('mirrors a lane conversation status through the core seam', () => {
        const core = coreOf();
        const thread = core.createThread('primary');

        expect(core.setThreadStatus(thread.id, 'running').status).toBe('running');
        expect(core.setThreadStatus(thread.id, 'idle', thread.id).invocationId).toBe(thread.id);
        expect(core.thread(thread.id)).toMatchObject({ status: 'idle', invocationId: thread.id });
    });

    it('raises minting counters but never lowers them (the lease landing)', () => {
        const core = coreOf();

        expect(core.reserveIdentity({ runSequence: 500, threadSequence: 40 })).toEqual({
            runSequence: 500,
            threadSequence: 40,
            threadIdSequence: expect.any(Number),
            invocationCompletionSequence: 0
        });

        const lowered = core.reserveIdentity({ runSequence: 1, threadSequence: 1 });

        expect(lowered.runSequence).toBe(500);
        expect(lowered.threadSequence).toBe(40);
    });
});

// ---------------------------------------------------------------------------
// T10 findings, measured against the LIVE canonical harness (not the staged fold):
//   M2 - a group that did not complete must move NOTHING on the live object, and the lane
//        must be able to land the same boundary once it re-bases (no wedged lane, and no
//        turn that can never publish);
//   M3 - the same conversation may replace the result it owns, because a host thread's
//        invocation id IS its thread id by core design;
//   M4 - the delta a replica is missing is the messages, not a length;
//   S1 - a conversation this lane never created is readable from the canonical harness;
//   S5 - a refusal names the journal's actual reason;
//   S8 - an operator action is never executed on the coordinator.
// ---------------------------------------------------------------------------

describe('commit: an incomplete group moves nothing on the canonical harness (T10 M2)', () => {
    const dataOf = (core: Harness): Record<string, unknown> => (core.memory as unknown as { data: Record<string, unknown> }).data;

    it('leaves live memory and live transcript untouched, then lands on the retry', () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');

        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);

        const partial = authority.commit(EPOCH_A, group(1, [
            { kind: 'memory:set', key: 'shared.cache', value: 'from the lane', expects: ABSENT_DIGEST },
            { kind: 'transcript:append', threadId: thread.id, fromLength: 99, messages: [{ role: 'assistant', content: 'mine' }] }
        ]));

        expect(partial.status).toBe('partial');
        expect(partial.complete).toBe(false);
        // The probe measured the opposite: the staged fold rolled back while the applier
        // replayed the individually-applied receipt, so canonical memory got the value and the
        // lane's base said it never happened.
        expect(partial.receipts.map((receipt) => receipt.rejection?.code)).toEqual(['group-rolled-back', 'prefix-moved']);
        expect(partial.receipts[0].effect).toBeUndefined();
        expect(dataOf(core)['shared.cache']).toBeUndefined();
        expect(core.threadMessages(thread.id)).toHaveLength(0);
        // The canonical fact the lane needs to re-base is in the refusal that caused this.
        expect(partial.receipts[1].effect?.length).toBe(0);
        expect(authority.journal.appliedThrough(EPOCH_A)).toBe(0);
        expect(authority.journal.mayPublishSuccess(EPOCH_A, 1)).toBe(false);

        // The next boundary, re-derived against the facts the receipts carried. One contested
        // op used to wedge EVERY later commit of that lane; here the same lane simply lands.
        const retried = authority.commit(EPOCH_A, group(2, [
            { kind: 'memory:set', key: 'shared.cache', value: 'from the lane', expects: ABSENT_DIGEST },
            { kind: 'transcript:append', threadId: thread.id, fromLength: 0, messages: [{ role: 'assistant', content: 'mine' }] }
        ]));

        expect(retried.complete).toBe(true);
        expect(dataOf(core)['shared.cache']).toBe('from the lane');
        expect(core.threadMessages(thread.id).map((message) => (message as { content: string }).content)).toEqual(['mine']);
        expect(authority.journal.mayPublishSuccess(EPOCH_A, 2)).toBe(true);
    });

    it('refuses a memory write to a key outside the window the lane was given (S6)', () => {
        const core = coreOf();
        const authority = authorityFor(core, { memoryKeys: ['mine.key'] });

        dataOf(core)['sibling.key'] = 'canonical value';

        const outcome = authority.commit(EPOCH_A, group(1, [
            { kind: 'memory:set', key: 'sibling.key', value: 'lane guess', expects: ABSENT_DIGEST }
        ]));

        expect(outcome.complete).toBe(false);
        expect(outcome.receipts[0].rejection?.code).toBe('memory-undeclared');
        expect(outcome.receipts[0].effect?.digest).toBe(expectsDigestOf('canonical value'));
        expect(dataOf(core)['sibling.key']).toBe('canonical value');
    });
});

describe('commit: one conversation owns the result it archives (T10 M3)', () => {
    const archivedOf = (core: Harness, invocationId: string): { content: string; completedOrder: number }[] =>
        ((core.snapshot() as unknown as { agentResults: { invocationId: string; content: string; completedOrder: number }[] }).agentResults ?? []).filter(
            (record) => record.invocationId === invocationId
        );

    it('replaces its own slot on the next turn instead of keeping the first answer forever', () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');

        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);

        const archiveOp = (content: string, sequence: number, completedOrder: number): MutationGroup['ops'][number] => ({
            kind: 'result:archive',
            invocationId: thread.id,
            sequence,
            completedOrder,
            agent: 'primary',
            role: 'primary',
            runKind: 'root',
            status: 'completed',
            content
        });

        const first = authority.commit(EPOCH_A, group(1, [archiveOp('answer one', 1, 1)]));
        // The retired fold refused this second commit outright ('already archived'), so the
        // canonical archive kept 'answer one' for the whole life of the conversation.
        const second = authority.commit(EPOCH_A, group(2, [archiveOp('answer two', 2, 2)]));

        expect(first.receipts[0].status).toBe('applied');
        expect(second.complete).toBe(true);
        expect(archivedOf(core, thread.id).map((record) => record.content)).toEqual(['answer two']);
        // The ORDER stays the authority's, even though the lane proposed one.
        expect(archivedOf(core, thread.id)[0].completedOrder).toBeGreaterThanOrEqual(2);
        // A repeat of an unchanged result digests the same, which is what lets a lane skip it
        // instead of re-archiving every boundary: the authority-assigned order is not in it.
        const unchanged = authority.commit(EPOCH_A, group(3, [archiveOp('answer two', 2, 40)]));

        expect(unchanged.receipts[0].effect?.digest).toBe(second.receipts[0].effect?.digest);
    });

    it('refuses a foreign live epoch, and frees the slot when the owner is retired', () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');

        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);

        const archiveOp = (content: string, sequence: number): MutationGroup['ops'][number] => ({
            kind: 'result:archive',
            invocationId: thread.id,
            sequence,
            completedOrder: sequence,
            agent: 'primary',
            role: 'primary',
            runKind: 'root',
            status: 'completed',
            content
        });

        authority.commit(EPOCH_A, group(1, [archiveOp('lane A answer', 1)]));

        const collision = authority.commit(EPOCH_B, group(1, [archiveOp('lane B invented it', 2)]));

        expect(collision.receipts[0].rejection?.code).toBe('not-writer');
        expect(archivedOf(core, thread.id).map((record) => record.content)).toEqual(['lane A answer']);

        // A reclaim: the lane that owned that conversation is gone, so the one that runs it now
        // may update its own invocation instead of being refused by a dead epoch.
        authority.closeLane(EPOCH_A);

        const adopted = authority.commit(EPOCH_B, group(2, [archiveOp('lane B second turn', 3)]));

        expect(adopted.receipts[0].status).toBe('applied');
        expect(archivedOf(core, thread.id).map((record) => record.content)).toEqual(['lane B second turn']);
    });
});

describe('answer: the canonical transcript delta and the routed thread read (T10 M4/S1)', () => {
    it('answers exactly the messages the replica has not adopted', async () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');

        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);

        // The lane publishes its own turn...
        const committed = authority.commit(EPOCH_A, group(1, [
            { kind: 'transcript:append', threadId: thread.id, fromLength: 0, messages: [{ role: 'user', content: 'mine' }] }
        ]));

        expect(committed.receipts[0].effect?.length).toBe(1);

        // ...and a sibling's send lands canonically, which the replica never saw. The retired
        // host shipped only the LENGTH, so the lane skipped its own messages at that base.
        core.appendThreadMessages(thread.id, [{ role: 'user', content: 'from a sibling lane' }], 1);

        const synced = await authority.answer(EPOCH_A, { op: 'transcript:sync', threadId: thread.id, haveLength: 1 });
        const delta = synced.value as { threadId: string; fromLength: number; length: number; messages: { content: string }[] };

        expect(delta.threadId).toBe(thread.id);
        expect(delta.fromLength).toBe(1);
        expect(delta.length).toBe(2);
        expect(delta.messages.map((message) => message.content)).toEqual(['from a sibling lane']);

        // Already level: nothing to insert, so a lane cannot duplicate what it has.
        const level = await authority.answer(EPOCH_A, { op: 'transcript:sync', threadId: thread.id, haveLength: 2 });

        expect((level.value as { messages: unknown[] }).messages).toEqual([]);

        // Canonical got shorter than the lane's base (a rewrite or a reset): the whole
        // transcript is the new prefix, and the answer says so instead of lying about a delta.
        const behind = await authority.answer(EPOCH_A, { op: 'transcript:sync', threadId: thread.id, haveLength: 9 });

        expect(behind.value).toMatchObject({ fromLength: 0, length: 2, rebased: true });
    });

    it('reads a conversation this lane never created from the canonical harness (S1)', async () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const sibling = core.createThread('primary', { label: 'sibling' });

        core.appendThreadMessages(sibling.id, [{ role: 'user', content: 'canonical text' }], 0);

        const read = await authority.answer(EPOCH_A, { op: 'thread:read', threadId: sibling.id, identity: {} });
        const value = read.value as { record: { id: string; label?: string }; messages: { content: string }[]; length: number };

        expect(value.record).toMatchObject({ id: sibling.id, label: 'sibling' });
        expect(value.messages.map((message) => message.content)).toEqual(['canonical text']);
        expect(value.length).toBe(1);

        // An id that never existed is the harness's own honest error, not an empty answer.
        await expect(authority.answer(EPOCH_A, { op: 'thread:read', threadId: 'thread-999', identity: {} })).rejects.toThrow(
            /has no record in this session/
        );
    });
});

describe('refusals a lane can act on (T10 S5/S8)', () => {
    it('names the journal reason instead of always "epoch superseded"', () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');

        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);

        const append = (fromLength: number): MutationGroup['ops'] => [
            { kind: 'transcript:append', threadId: thread.id, fromLength, messages: [{ role: 'user', content: 'x' }] }
        ];

        expect(authority.commit(EPOCH_A, group(1, append(0))).complete).toBe(true);

        // A re-send of a settled seq: recoverable, and the message says what to do with it.
        const duplicate = authority.commit(EPOCH_A, group(1, append(1)));

        expect(duplicate.receipts[0].rejection?.code).toBe('seq-duplicate');
        expect(duplicate.receipts[0].rejection?.message).toBe('Commit 1 was already settled for lane 1; the reply is the earlier receipt, and the base behind it already moved.');

        // A group behind this lane's own watermark: also recoverable, also its own code.
        const behind = authority.commit(EPOCH_A, group(0, append(1)));

        expect(behind.receipts[0].rejection?.code).toBe('seq-behind');
        expect(behind.receipts[0].rejection?.message).toContain("behind lane 1's applied watermark at 1");

        // The one case the retired code described.
        authority.closeLane(EPOCH_A);

        const dead = authority.commit(EPOCH_A, group(3, append(1)));

        expect(dead.receipts[0].rejection?.code).toBe('epoch-superseded');
        expect(dead.receipts[0].rejection?.message).toBe('Lane 1 is retired; its commits are no longer applied.');
    });

    it('refuses an operator invocation raised as a request instead of running it on the coordinator (S8)', async () => {
        const core = coreOf();
        const authority = authorityFor(core);

        await expect(authority.answer(EPOCH_A, { op: 'execute:tool', name: 'task', parameters: {} })).rejects.toThrow(/operator invocation frame/);
        await expect(authority.answer(EPOCH_A, { op: 'execute:command', line: '/reset' })).rejects.toThrow(/executes it on its own CPU/);
    });
});

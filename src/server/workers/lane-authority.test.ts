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
//   - that archive names the CONVERSATION it belongs to, so deleting the conversation
//     purges the lane's result exactly as it purges an inline one — and an op without
//     the field keeps the weaker, documented behaviour (stress report #6, 2026-11-14);
//   - that archive carries the FORENSIC PAIR of a run that did not finish, so the canonical
//     row says what a stopped lane child actually said; a malformed value is refused before
//     anything moves and burns no completion order; and a live refusal names the permanent
//     code rather than the op kind's usual conflict (review #5, issues 0020 + 0033);
//   - memory commits are compare-and-set against the canonical map: a stale digest is
//     refused and the canonical digest comes back (T3 F4/F7);
//   - routed `runtime` operations mutate the canonical store with a core-minted id (the
//     central task mutation worker mode promises), and a cross-thread send from a lane
//     starts the target conversation at the authority (D2 linearizable reads at a
//     committed boundary);
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '@underload/harness';
import type { Harness, HarnessMessage, HarnessStream, HarnessStreamEvent } from '@underload/harness';
import { canonicalViewOf, createLaneAuthority } from './lane-authority';
// `archiveDigestOf` is the projection both sides of the archive seam must agree on; the pair pins
// below compare a receipt against it, so the test states the writer's own rule rather than trusting
// the authority to restate it.
import { archiveDigestOf, expectsDigestOf } from './lane-commit';
import type { MutationGroup, SharedMutation } from './lane-commit';
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
        expect(authority.ledger.watermarkOf('record')).toBe(0);
        expect(authority.ledger.publishedOf('record')).toBe(1);
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

// pipeline T4.1 (and context-inclusion T3, whose acceptance artifact this is): the in-place
// write a lane's plugin makes on an ALREADY-COMMITTED entry — the `included` flag, and the text
// `edit` changes — must reach the AUTHORITY's conversation, be reported there so the server
// persists it, and survive the trip a restart takes. Before T4 the lane owed only appended
// slices, so this whole class of write died with the worker process (finding F6).
describe('commit: an in-place change to the committed prefix becomes canonical state (T4.1)', () => {
    // A conversation this lane already published: a question and its answer, both committed, so
    // everything the cases below change is inside the lane's ADOPTED prefix.
    const seed = (core: Harness, threadId: string): HarnessMessage[] => {
        core.setThreadMessages(threadId, [
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'answer' }
        ] as never);

        // The canonical form, including the addresses the core minted on the way in: a lane's
        // replica holds exactly these objects, and its `expects` digest is taken over them.
        return core.threadMessages(threadId);
    };

    it('lands a flag and a text edit on the canonical conversation and reports ONE agent_message', () => {
        const reported: string[] = [];
        const core = harness({
            agents: {
                primary: agent({ name: 'primary', model: 'm', instructions: 'Test primary.', stream: quiet() })
            },
            presets: false,
            // The server's durability mechanism is this observer (../sessions.ts
            // `noteStateChange`), so the count and the reason are the thing under test: a lane
            // patch that never notified would land in memory and be lost at the next restart.
            report: {
                progress: async () => undefined,
                stateChange: (event) => reported.push(`${event.reason}:${event.agent ?? ''}`)
            }
        });
        const authority = authorityFor(core);
        const thread = core.createThread('primary');
        const committed = seed(core, thread.id);

        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);
        reported.length = 0;

        const patched = [
            { ...committed[0], included: false },
            { ...committed[1], content: 'answer, rewritten by the plugin' }
        ];

        const outcome = authority.commit(EPOCH_A, group(1, [
            {
                kind: 'transcript:patch',
                threadId: thread.id,
                expectedLength: 2,
                expects: digestMemoryValue(committed),
                messages: patched
            }
        ]));

        expect(outcome.complete).toBe(true);
        // The receipt reports the PREFIX scope (the part this lane holds), not the whole
        // transcript — the rule ./lane-commit.ts states and the lane's base adopts.
        expect(outcome.receipts[0].effect).toEqual({ length: 2, digest: digestMemoryValue(patched) });

        // THE AUTHORITY's transcript, read back through the core's own reader: the flag and the
        // new text are canonical state now, addresses preserved.
        expect(core.threadMessages(thread.id)).toEqual([
            { role: 'user', content: 'question', messageId: 'msg-1', included: false },
            { role: 'assistant', content: 'answer, rewritten by the plugin', messageId: 'msg-2' }
        ]);

        // And the write is durable-by-notification: exactly one `agent_message`, the same reason
        // every other transcript write reports (no new reason, no per-entry storm).
        expect(reported).toEqual(['agent_message:primary']);

        // The restart primitive: the committed snapshot carries the flag and the text, and a
        // harness restored from it answers the same way. This is the half the contract sentence
        // used to disclaim (src/types/index.ts `setIncluded`, PERSISTENCE — PRECISE SCOPE).
        const snapshot = JSON.parse(JSON.stringify(core.snapshot())) as never;
        // The SAME harness configuration, freshly built and never told a plugin existed: what a
        // server process looks like after a restart.
        const rebuilt = harness({
            agents: {
                primary: agent({ name: 'primary', model: 'm', instructions: 'Test primary.', stream: quiet() })
            },
            presets: false
        });

        rebuilt.restore(snapshot);

        expect(rebuilt.threadMessages(thread.id)).toEqual([
            { role: 'user', content: 'question', messageId: 'msg-1', included: false },
            { role: 'assistant', content: 'answer, rewritten by the plugin', messageId: 'msg-2' }
        ]);
    });

    it('refuses a stale digest with prefix-moved and changes neither the transcript or the store', () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');
        const committed = seed(core, thread.id);

        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);

        // Canonical moved first: the coordinator wrote its own answer into entry 1.
        core.patchThreadMessages(
            thread.id,
            [committed[0], { ...committed[1], content: 'answer, written by the host' }],
            2
        );

        const outcome = authority.commit(EPOCH_A, group(2, [
            {
                kind: 'transcript:patch',
                threadId: thread.id,
                expectedLength: 2,
                // The digest from BEFORE the host write: exactly what a lane holds when canonical
                // moves under it.
                expects: digestMemoryValue(committed),
                messages: [committed[0], { ...committed[1], content: 'answer, from the lane' }]
            }
        ]));

        expect(outcome.complete).toBe(false);
        expect(outcome.receipts[0].status).toBe('rejected');
        expect(outcome.receipts[0].rejection?.code).toBe('prefix-moved');
        // The canonical facts ride the refusal so the lane can re-read and re-derive.
        expect(outcome.receipts[0].effect).toEqual({
            length: 2,
            digest: digestMemoryValue(core.threadMessages(thread.id))
        });
        expect(core.threadMessages(thread.id).map((message) => message.content)).toEqual([
            'question',
            'answer, written by the host'
        ]);
    });

    it('refuses a patch that would move a committed entry\'s role or address, and writes nothing', () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');
        const committed = seed(core, thread.id);

        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);

        // Same digest, same length — the CAS passes and the CORE seam is what refuses, so the
        // group is partial and the canonical transcript is untouched (T10's bounded-prefix rule).
        const roleSwap = authority.commit(EPOCH_A, group(2, [
            {
                kind: 'transcript:patch',
                threadId: thread.id,
                expectedLength: 2,
                expects: digestMemoryValue(committed),
                messages: [
                    // entry 0 turns into an assistant message: provider pairing and the exclusion
                    // unit both resolve on role, so this is a different turn, not an edit.
                    { ...committed[0], role: 'assistant' },
                    committed[1]
                ]
            }
        ]));

        expect(roleSwap.complete).toBe(false);
        expect(roleSwap.receipts[0].rejection?.code).toBe('invalid-mutation');
        expect(roleSwap.receipts[0].rejection?.message).toBe(
            'Thread "' + thread.id + '" patch would change entry 0 from "user" to "assistant"; a committed entry keeps its role.'
        );

        const movedAddress = authority.commit(EPOCH_A, group(3, [
            {
                kind: 'transcript:patch',
                threadId: thread.id,
                expectedLength: 2,
                expects: digestMemoryValue(committed),
                messages: [
                    // An address is how a LATER round names this turn (`setIncluded(messageId)`);
                    // rewriting it would silently re-point the caller's own decision.
                    { ...committed[0], messageId: 'msg-9' },
                    committed[1]
                ]
            }
        ]));

        expect(movedAddress.complete).toBe(false);
        expect(movedAddress.receipts[0].rejection?.message).toBe(
            'Thread "' + thread.id + '" patch would move entry 0 from address "msg-1" to "msg-9"; a committed entry keeps its address.'
        );

        expect(core.threadMessages(thread.id)).toEqual(committed);
    });

    it('keeps the tail a coordinator appended after this lane read its prefix', () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');
        const committed = seed(core, thread.id);

        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);

        // A sibling's send grew the conversation after the lane adopted its 2-entry base.
        core.appendThreadMessages(thread.id, [{ role: 'user', content: 'from a sibling lane' }], 2);

        const outcome = authority.commit(EPOCH_A, group(2, [
            {
                kind: 'transcript:patch',
                threadId: thread.id,
                expectedLength: 2,
                expects: digestMemoryValue(committed),
                messages: [{ ...committed[0], included: false }, committed[1]]
            }
        ]));

        expect(outcome.complete).toBe(true);
        // The patch rewrote [0..2] and left the sibling's message exactly where canonical put it.
        expect(core.threadMessages(thread.id)).toEqual([
            { role: 'user', content: 'question', messageId: 'msg-1', included: false },
            { role: 'assistant', content: 'answer', messageId: 'msg-2' },
            { role: 'user', content: 'from a sibling lane', messageId: 'msg-3' }
        ]);
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

    // STRESS REPORT #6 / worker mode (2026-11-14) — THE PURGE RULE WAS SILENTLY WEAKER ON A
    // LANE.
    //
    // `purgeThread`'s predicate is `record.threadId === the deleted conversation`, plus the
    // roster's own `record.invocationId === state.record.invocationId` for the newest turn. A
    // lane-archived record used to carry NO threadId at all (the `result:archive` op did not
    // name one, and `archiveInvocation` rebuilds the record whole), so on a conversation that
    // never ran on the authority — where the roster's invocation slot is empty — the delete
    // caught only the newest result at best and left every earlier lane turn addressable. The
    // same delete inline removed all of them. The op now carries the conversation, and these
    // two cases pin both halves: what the field buys, and that an omitted field is still the
    // documented weaker behaviour rather than a guess.
    it('archives the owning conversation, so deleting it purges the lane result (F6 parity with inline)', () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');

        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);

        // A lane-minted identity: NOT the thread id, and the authority's roster never named it
        // (the run happened on the replica), so `record.threadId` is the only join the delete
        // purge can use.
        const outcome = authority.commit(EPOCH_A, group(1, [
            {
                kind: 'result:archive',
                invocationId: '513',
                sequence: 7,
                completedOrder: 999,
                agent: 'primary',
                role: 'primary',
                runKind: 'root',
                status: 'completed',
                content: 'the lane answered',
                threadId: thread.id
            }
        ]));

        expect(outcome.complete).toBe(true);
        expect((core.snapshot().agentResults ?? []).map((record) => record.invocationId)).toEqual(['513']);

        // The receipt states the purge, exactly as it does for an inline conversation.
        expect(core.deleteThread(thread.id)).toEqual({
            deleted: thread.id,
            removedThreadIds: [thread.id],
            removedInvocationIds: ['513'],
            removedBranchIds: []
        });
        expect(core.snapshot().agentResults ?? []).toEqual([]);
    });

    it('without the conversation on the op the result survives the delete (the retired weaker lane rule)', () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');

        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);

        // An older send, or a session-side archive that names no conversation: the authority
        // stores the result, and NOTHING joins it to the conversation. This is the state the
        // stress report found — `agentResult` still answering for a released conversation —
        // pinned so the omission stays a named case instead of an accident.
        authority.commit(EPOCH_A, group(1, [
            {
                kind: 'result:archive',
                invocationId: '513',
                sequence: 7,
                completedOrder: 999,
                agent: 'primary',
                role: 'primary',
                runKind: 'root',
                status: 'completed',
                content: 'the lane answered'
            }
        ]));

        expect(core.deleteThread(thread.id)).toEqual({
            deleted: thread.id,
            removedThreadIds: [thread.id],
            removedInvocationIds: [],
            removedBranchIds: []
        });
        expect((core.snapshot().agentResults ?? []).map((record) => record.invocationId)).toEqual(['513']);
    });

    // Review finding #5 / issues 0020 + 0033 (2026-11-14) — THE FORENSIC PAIR, AUTHORITY END.
    //
    // A lane replica has always known what its stopped run said: `finishInvocation` writes
    // `partialContent`/`cancelledAtMessage` on the terminal transition (src/harness.ts:3886-3898) and
    // the snapshot projection carries both. What the archive seam never carried was the pair, so a
    // lane-archived cancellation reached canonical state as `content: ''` with no partial at all —
    // issue 0020's "significant cancelled child reports no partial content", with NO restart
    // involved, because the loss was in this payload. These three cases pin the authority end: the
    // pair lands on the canonical row, a malformed value is refused without moving canonical state,
    // and a live refusal names the code a lane can act on.
    it('archives the forensic pair so the canonical row says what the stopped run said', () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');

        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);

        const stopped = {
            kind: 'result:archive',
            invocationId: '513',
            sequence: 7,
            // The lane's LOCAL order: the authority reassigns it, and `archiveDigestOf` ignores it,
            // which is exactly why the pair — a writer-owned field — is not in the same exemption.
            completedOrder: 999,
            agent: 'primary',
            role: 'subagent',
            runKind: 'delegation',
            status: 'cancelled',
            content: '',
            error: 'The run was cancelled.',
            partialContent: 'I will read the file, then summarise it',
            cancelledAtMessage: 2,
            threadId: thread.id
        } satisfies SharedMutation;

        const outcome = authority.commit(EPOCH_A, group(1, [stopped]));

        expect(outcome.complete).toBe(true);

        // The CORE's own projection, not a restatement of the payload: this row is what a session
        // read, `/results`, `agentResult` and the next snapshot all serve.
        const archived = (core.snapshot().agentResults ?? []).find((record) => record.invocationId === '513');

        expect(archived).toEqual({
            invocationId: '513',
            sequence: 7,
            completedOrder: 1,
            agent: 'primary',
            role: 'subagent',
            kind: 'delegation',
            status: 'cancelled',
            content: '',
            error: 'The run was cancelled.',
            partialContent: 'I will read the file, then summarise it',
            cancelledAtMessage: 2,
            threadId: thread.id
        });

        // The receipt digest is the digest the WRITER computes from the record it sent. That
        // equality is load-bearing twice over: `deriveOperations` decides whether to emit the op at
        // all from `lane.archived` vs `archiveDigestOf(record)`, and a lane that lands an op whose
        // receipt digest differs re-derives it forever. `completedOrder` is the one excluded field
        // (the authority re-mints it above); the pair is NOT excluded, so it has to be here.
        const writerProjection = {
            invocationId: '513',
            sequence: 7,
            completedOrder: 999,
            agent: 'primary',
            role: 'subagent',
            kind: 'delegation',
            status: 'cancelled',
            content: '',
            error: 'The run was cancelled.',
            partialContent: 'I will read the file, then summarise it',
            cancelledAtMessage: 2
        };

        expect(outcome.receipts[0].effect?.digest).toBe(archiveDigestOf(writerProjection));

        // And the fold view the NEXT commit is staged against is built from that row, pair included
        // — the round trip is what makes a replay a no-op instead of a fresh diff every boundary.
        const view = canonicalViewOf(core, (core.memory as unknown as { data: Record<string, unknown> }).data);

        expect(view.results['513']).toEqual(archived);
        expect(outcome.receipts[0].effect?.digest).toBe(archiveDigestOf(view.results['513']));

        // Re-committing the same archive is idempotent in the only way that matters: the digest (and
        // therefore the lane's skip test) is unchanged. `completedOrder` is the one field the
        // authority re-mints on a replace, which is exactly the field the digest excludes — so the
        // row's order moves and the writer still sees its own op as landed.
        const replay = authority.commit(EPOCH_A, group(2, [stopped]));

        expect(replay.complete).toBe(true);
        expect(replay.receipts[0].effect?.digest).toBe(outcome.receipts[0].effect?.digest);
        expect(core.snapshot().agentResults ?? []).toEqual([{ ...archived, completedOrder: 2 }]);
    });

    it('refuses a malformed forensic pair before canonical state moves, and burns no completion order', () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');

        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);

        // The op shape is written once; each case below supplies only the forensic pair it wants to
        // exercise, so a payload typo cannot quietly turn a refusal test into a no-op test.
        type ArchiveOp = Extract<SharedMutation, { kind: 'result:archive' }>;

        const archiveFor = (overrides: Partial<ArchiveOp>, invocationId: string, seq: number) =>
            authority.commit(EPOCH_A, group(seq, [
                {
                    kind: 'result:archive',
                    invocationId,
                    sequence: 7,
                    completedOrder: 999,
                    agent: 'primary',
                    role: 'subagent',
                    runKind: 'delegation',
                    status: 'cancelled',
                    content: '',
                    error: 'The run was cancelled.',
                    threadId: thread.id,
                    ...overrides
                } satisfies ArchiveOp
            ]));

        // A negative message index: `>= 0` is the bound ../core/snapshot.ts reads the row back with,
        // so a value below it is a payload that could never survive a reload.
        const negative = archiveFor({ partialContent: 'half an answer', cancelledAtMessage: -1 }, '513', 1);

        expect(negative.complete).toBe(false);
        expect(negative.receipts[0].status).toBe('rejected');
        expect(negative.receipts[0].rejection?.code).toBe('invalid-mutation');

        // A present-but-blank partial, the other malformed shape, refused for the same reason:
        // "present" is the claim that the run said something.
        const blank = archiveFor({ partialContent: '   ', cancelledAtMessage: 1 }, '514', 2);

        expect(blank.complete).toBe(false);
        expect(blank.receipts[0].rejection?.code).toBe('invalid-mutation');

        // NOTHING moved on the canonical harness: no rows at all, and a refusal that half-wrote the
        // pair would leave a row whose forensics disagree with its status.
        expect(core.snapshot().agentResults ?? []).toEqual([]);

        // And the refusal burned no completion ORDER. `archiveInvocation` validates before it
        // increments `invocationCompletionSequence`, so the next real archive is order 1: an
        // authority that minted first would hand `/results` a gap nobody can explain.
        const landed = archiveFor({ partialContent: 'half an answer', cancelledAtMessage: 1 }, '515', 3);

        expect(landed.complete).toBe(true);
        expect((core.snapshot().agentResults ?? []).map((record) => [record.invocationId, record.completedOrder])).toEqual([
            ['515', 1]
        ]);
    });

    it('names `invalid-mutation` when the LIVE core refuses an archive, not the kind default conflict (S5)', () => {
        const core = coreOf();
        const authority = authorityFor(core);

        // The fold has no roster, so an archive for an unregistered agent is ACCEPTED by the staged
        // view and refused by the live write. The kind's default live conflict is `stale-record`
        // (`liveRejectionCodeOf`), which tells the lane its base moved and invites it to re-derive
        // the same row forever. This throw is permanent, so the replay names it as such — the way
        // `transcript:patch` already does.
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
        expect(outcome.receipts[0].rejection?.code).toBe('invalid-mutation');
        expect(outcome.receipts[0].rejection?.message).toBe(
            'Agent "ghost" is not registered in this harness, so its invocation cannot be archived.'
        );
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
            method: 'executeRecords',
            name: 'tasks',
            parameters: { tasks: [{ text: 'from lane A' }] },
            identity: { agent: 'primary', threadId: 'thread-1', runDepth: 1 }
        });

        expect(JSON.stringify(first.value)).toContain('from lane A');

        // A DIFFERENT lane reads the same store: it sees the record with the id the core
        // minted, which is the whole point of routing instead of merging.
        const second = await authority.answer(EPOCH_B, {
            op: 'runtime',
            method: 'executeRecords',
            name: 'tasks',
            parameters: {},
            identity: { agent: 'primary', threadId: 'thread-2', runDepth: 1 }
        });

        expect(JSON.stringify(second.value)).toContain('from lane A');
        expect(JSON.stringify(second.value)).toContain('"id":"1"');

        // The ledger ADOPTED the id the core minted, so the next lease this session hands a
        // lane starts after it (T3 finding F1's collision, prevented at the source).
        expect(authority.ledger.publishedOf('record')).toBe(2);
        expect(first.sync?.identities?.['record']).toBe(1);
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

        // STATE-AWARE delivery (delegate-stress T3.2/T3.6, src/harness.ts
        // `postThreadMessage`): an idle target is no longer an inert append, so the
        // authority reports that it STARTED a run. Routing is unchanged — the send is
        // still answered at the canonical harness, never in the calling replica — and
        // the receipt is still non-blocking, which is what keeps `threadSend` out of
        // the nested-run door set (./capability.ts `NESTED_RUN_ARMED_DOORS`).
        expect(sent.value).toEqual({
            threadId: target.id,
            delivered: 'started',
            sender: 'primary'
        });

        // The delivered message is the run's own root prompt, so it appears as the
        // first user turn the moment the run commits it. The receipt did NOT wait for
        // the answer, hence the bounded wait for the scripted run to settle below —
        // exact assertions, not a race with the run's own appends.
        const deliveredUpTo = async (): Promise<string[]> =>
            core.threadMessages(target.id).map((message) => (message as { content: string }).content);

        for (let attempt = 0; attempt < 50; attempt += 1) {
            if (core.thread(target.id)?.status === 'idle' && (await deliveredUpTo()).length > 0) break;
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }

        // The delivered text is the core's own attribution format, stated exactly.
        const delivered = await deliveredUpTo();

        expect(delivered).toEqual([
            'from agent "primary":\nhello from a lane',
            'unused'
        ]);

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

// ---------------------------------------------------------------------------
// T1: two lanes, ONE canonical task store
// ---------------------------------------------------------------------------
//
// A lane's `record:update` carries a DIGEST `expects` (./lane-commit.ts), which is the
// commit-group CAS for the fold view. The task tool's OWN compare-and-swap is a
// different guard entirely: `{ id, rev }` tokens checked by the canonical store
// (../../core/task.ts) against the record's content revision. Routed `task` writes go
// to the store, so a stale token must be refused THERE - by the same message the
// inline path produces - and never by a lane receipt.
describe('routed task writes: the canonical store owns the compare-and-swap', () => {
    // The task stamps every write from Date, so the clock is pinned for this block
    // only (`toFake: ['Date']` leaves the scheduler real): each `updatedAt`, `at` and
    // `leaseUntil` then has ONE exact value to assert.
    const EPOCH_ISO = '2026-01-01T00:00:00.000Z';
    const EPOCH_MS = Date.parse(EPOCH_ISO);

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(EPOCH_MS);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    type TaskPageValue = {
        tasks: Array<Record<string, unknown>>;
        counts: { total: number; completed: number; pending: number };
        page: { offset: number; limit: number; hasMore: boolean };
        storeRev: number;
        changes?: Array<Record<string, unknown>>;
    };

    // One routed call, projected to the value the lane received.
    const routedTask = async (
        authority: ReturnType<typeof createLaneAuthority>,
        laneEpoch: number,
        agent: string,
        threadId: string,
        parameters: Record<string, unknown>
    ): Promise<TaskPageValue> => {
        const answer = await authority.answer(laneEpoch, {
            op: 'runtime',
            method: 'executeRecords',
            name: 'tasks',
            parameters,
            identity: { agent, threadId, runDepth: 1 }
        });

        return answer.value as TaskPageValue;
    };

    it('applies one lane write and refuses the other lane stale token, atomically', async () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const threadA = core.createThread('primary');
        const threadB = core.createThread('primary');

        // Lane A mints the record. The id comes from the CORE store, which is what the
        // identity ledger then adopts (the T3 F1 prevention above).
        const added = await routedTask(authority, EPOCH_A, 'primary', threadA.id, {
            tasks: [{ text: 'shared record' }]
        });

        expect(added.tasks).toEqual([
            {
                id: '1',
                text: 'shared record',
                completed: false,
                rev: 1,
                updatedBy: 'primary',
                updatedThreadId: threadA.id,
                updatedAt: EPOCH_ISO
            }
        ]);
        expect(added.storeRev).toBe(1);

        // Lane B reads the SAME store and takes the token it saw.
        const readByB = await routedTask(authority, EPOCH_B, 'primary', threadB.id, {});

        expect(readByB.tasks[0].rev).toBe(1);
        expect(readByB.tasks[0].updatedThreadId).toBe(threadA.id);

        // Lane B writes first, with the token from that read.
        const bWrote = await routedTask(authority, EPOCH_B, 'primary', threadB.id, {
            tasks: [{ id: '1', text: 'lane B won' }],
            expects: [{ id: '1', rev: 1 }]
        });

        expect(bWrote.tasks).toEqual([
            {
                id: '1',
                text: 'lane B won',
                completed: false,
                rev: 2,
                updatedBy: 'primary',
                updatedThreadId: threadB.id,
                updatedAt: EPOCH_ISO
            }
        ]);
        expect(bWrote.storeRev).toBe(2);

        // Lane A, still holding rev 1, is refused BY THE CANONICAL STORE. The error is
        // the tool's own CAS sentence - the same one the inline path would throw - not
        // a `stale-record` receipt from the fold, because this write never went through
        // a commit group.
        await expect(
            routedTask(authority, EPOCH_A, 'primary', threadA.id, {
                tasks: [{ id: '1', completed: true }],
                expects: [{ id: '1', rev: 1 }]
            })
        ).rejects.toThrow(
            // The engine's ONE CAS sentence (src/core/records.ts `staleRecordError`), whose
            // message starts with the `stale-record:` code: current rev, last editor AND the
            // instant, the changed fields, then R9's recovery hint and the current record.
            // The label is the TOOL name, because the lane called the `tasks` wrapper.
            'tasks "1" changed since revision 1 (now 2, last edited by "primary" at ' +
                EPOCH_ISO +
                '); changed fields: text; retry with "expects" [{ id: "1", rev: 2 }] or pass "mergeDisjoint": true.'
        );

        // The refusal moved nothing anywhere: B's text, rev 2 and the two recorded
        // events are exactly what they were, so the winning lane's work survives.
        const canonical = await routedTask(authority, EPOCH_A, 'primary', threadA.id, { since: 0 });

        expect(canonical.tasks).toEqual([
            {
                id: '1',
                text: 'lane B won',
                completed: false,
                rev: 2,
                updatedBy: 'primary',
                updatedThreadId: threadB.id,
                updatedAt: EPOCH_ISO
            }
        ]);
        expect(canonical.storeRev).toBe(2);
        expect(canonical.changes).toEqual([
            { rev: 1, id: '1', op: 'add', by: 'primary', threadId: threadA.id, at: EPOCH_ISO, itemRev: 1 },
            {
                rev: 2,
                id: '1',
                op: 'update',
                by: 'primary',
                threadId: threadB.id,
                at: EPOCH_ISO,
                fields: ['text'],
                itemRev: 2
            }
        ]);

        // A re-reads at the canonical revision and its write lands.
        const retry = await routedTask(authority, EPOCH_A, 'primary', threadA.id, {
            tasks: [{ id: '1', completed: true }],
            expects: [{ id: '1', rev: 2 }]
        });

        expect(retry.tasks).toEqual([
            {
                id: '1',
                text: 'lane B won',
                completed: true,
                rev: 3,
                updatedBy: 'primary',
                updatedThreadId: threadA.id,
                updatedAt: EPOCH_ISO
            }
        ]);
        expect(retry.storeRev).toBe(3);

        // The lane's own replica base cannot drift: the answer the authority hands back
        // IS the canonical page, and the identity ledger still points past the id the
        // core minted.
        expect(authority.ledger.publishedOf('record')).toBe(2);
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

    // pipeline T4.1: the PULL half now sees CONTENT, not only counts. An in-place canonical
    // change — an operator repairing one turn's text, or a sibling lane's committed
    // `transcript:patch` — moves no length, so the delta rule above answers "nothing missing" and
    // the replica would run its next turn on a transcript the authority no longer holds.
    it('rebases when the prefix this replica holds changed IN PLACE at the same length (T4.1)', async () => {
        const core = coreOf();
        const authority = authorityFor(core);
        const thread = core.createThread('primary');

        authority.leases.claim({ kind: 'thread', id: thread.id }, EPOCH_A);

        authority.commit(EPOCH_A, group(1, [
            {
                kind: 'transcript:append',
                threadId: thread.id,
                fromLength: 0,
                messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'second' }]
            }
        ]));

        const adopted = core.threadMessages(thread.id);
        const levelDigest = digestMemoryValue(adopted);

        // The pre-T4 answer at the lane's own length: an empty delta, "you are level".
        const level = await authority.answer(EPOCH_A, {
            op: 'transcript:sync',
            threadId: thread.id,
            haveLength: 2,
            haveDigest: levelDigest
        });

        expect((level.value as { messages: unknown[]; rebased?: boolean }).messages).toEqual([]);
        expect((level.value as { rebased?: boolean }).rebased).toBeUndefined();

        // An operator edits entry 1 without changing the length — the exact write the digest
        // exists to see.
        core.patchThreadMessages(
            thread.id,
            [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'second, repaired by the host', messageId: 'msg-2' }],
            2
        );

        const moved = await authority.answer(EPOCH_A, {
            op: 'transcript:sync',
            threadId: thread.id,
            haveLength: 2,
            haveDigest: levelDigest
        });
        const rebased = moved.value as { fromLength: number; length: number; rebased?: boolean; messages: { content: string }[] };

        expect(rebased.rebased).toBe(true);
        expect(rebased.fromLength).toBe(0);
        expect(rebased.length).toBe(2);
        expect(rebased.messages.map((message) => message.content)).toEqual(['first', 'second, repaired by the host']);

        // A stale digest with canonical AHEAD of the lane still answers the delta it is missing,
        // and a lane that states no digest at all keeps the pre-T4 answer: an older worker is
        // never refused for not knowing the field.
        core.appendThreadMessages(thread.id, [{ role: 'user', content: 'third' }], 2);

        const ahead = await authority.answer(EPOCH_A, {
            op: 'transcript:sync',
            threadId: thread.id,
            haveLength: 2,
            haveDigest: levelDigest
        });

        expect((ahead.value as { rebased?: boolean }).rebased).toBe(true);
        expect((ahead.value as { messages: { content: string }[] }).messages.map((message) => message.content)).toEqual([
            'first',
            'second, repaired by the host',
            'third'
        ]);

        const unstatement = await authority.answer(EPOCH_A, { op: 'transcript:sync', threadId: thread.id, haveLength: 2 });

        expect((unstatement.value as { fromLength: number; length: number; rebased?: boolean }).rebased).toBeUndefined();
        expect((unstatement.value as { messages: { content: string }[] }).messages.map((message) => message.content)).toEqual(['third']);
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
        // F2 (2026-11-14): the sentence is the CORE's, byte-for-byte — the routed door and the
        // inline door (src/harness.ts:5403) answer the same fact with the same head, so this
        // pin is an exact string, not a loose fragment of one variant.
        await expect(authority.answer(EPOCH_A, { op: 'thread:read', threadId: 'thread-999', identity: {} })).rejects.toThrow(
            'Thread "thread-999" is not available in this harness; it was never created, or it was deleted.'
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

        await expect(authority.answer(EPOCH_A, { op: 'execute:tool', name: 'tasks', parameters: {} })).rejects.toThrow(/operator invocation frame/);
        await expect(authority.answer(EPOCH_A, { op: 'execute:command', line: '/reset' })).rejects.toThrow(/executes it on its own CPU/);
    });
});

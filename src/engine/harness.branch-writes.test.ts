// F1 (2026-11-27) — the fork/branch/thread write doors, and what a branch may do with them.
//
// Contract pinned here:
//   - a `threadFork` BRANCH RUN is refused at the three WRITE doors (`threadSend`, `delegate`,
//     `threadDelete`) — a branch's persistent thread is its REQUESTER's, so every write lands in
//     the conversation the fork was created to keep clean — while the READ doors (`threadRead`,
//     `agentResult`) stay open with no flag (C2);
//   - the exception is the fork's own `allowFamilyWrites: true`, decided at creation, recorded on
//     the branch record, and read back by the doors (never re-read from a model argument);
//   - a branch message is attributed with the BRANCH id next to the owner conversation, so a
//     reader of the owner's transcript can tell isolated reasoning from its own owner speaking
//     (C4);
//   - a running branch appears in the MODEL roster as a row carrying `branchId`, while the host
//     roster (`harness.threads()`) keeps excluding branch runs, and a branch address is REFUSED as
//     a send target instead of answering with the false "never created, or it was deleted"
//     sentence (C4);
//   - `toolCancel` resolves the `branch-N` id a fork handed back as well as the callId, and its
//     receipt echoes the ids of the work it released (C3 / M6);
//   - a SOFT-DELETED conversation is readable by the lineage that owns it, and refused to a
//     stranger (the inactive-read caveat).
//
// WHY THE MODEL-DRIVEN SHAPE. A branch brain is unreachable from a test — it is the Agent
// `forkAgent` mints inside `launchThreadFork` — and the branch RECORD, which is what carries
// `allowFamilyWrites`, is created only by that door. So the guard is exercised through a real
// fork, and the transport is routed BY TRANSCRIPT exactly as ./harness.fork.test.ts routes it: a
// branch run's root user message is the fork task, the requester's is its own prompt, so the two
// runs of one transport never consume each other's frames.
//
// Harness-generated ids (`thread-N`) are READ, never hardcoded: the scripted turns close over
// variables assigned right after `createThread`, which runs before any request is built.

import { describe, expect, it } from 'vitest';
import { agent, harness } from './index';
import type { Harness, HarnessStream, HarnessStreamRequest, HarnessStreamEvent } from './index';
// The branch's forked transcript answers the requester's still-pending `threadFork` call — the call that
// CREATED the branch — with the M5 (2026-11-27) self-describing marker (./core/branch.ts
// `BRANCH_SELF_CALL_PLACEHOLDER`), so it is the FIRST tool row of every branch transcript below. Read from
// its module and never retyped — the convention ./harness.fork.test.ts uses for the same reason. (The
// generic non-success placeholder it used to carry is pinned by ./core/branch.test.ts and, for the
// requester's OTHER unsettled calls, by ./harness.branch-seed.test.ts.)
import { BRANCH_SELF_CALL_PLACEHOLDER } from './core/branch';

const frames = {
    answer: (text: string): HarnessStreamEvent[] => [
        { type: 'text', delta: text },
        { type: 'done', stopReason: 'stop', toolCalls: [] }
    ],
    call: (id: string, name: string, args: unknown): HarnessStreamEvent[] => [
        {
            type: 'done',
            stopReason: 'tool_calls',
            // `call.arguments` is a JSON STRING on the wire (the provider's shape).
            toolCalls: [{ id, name, arguments: JSON.stringify(args) }]
        }
    ],
    calls: (toolCalls: Array<{ id: string; name: string; arguments: unknown }>): HarnessStreamEvent[] => [
        {
            type: 'done',
            stopReason: 'tool_calls',
            toolCalls: toolCalls.map((toolCall) => ({
                ...toolCall,
                arguments: JSON.stringify(toolCall.arguments)
            }))
        }
    ]
};

const brain = (stream: HarnessStream) => agent({ model: 'merge/ds4-flash', stream });

// A brain that answers with one fixed text, for a conversation the branch writes INTO (it must
// not be routed through the requester's scripted turns).
const echoBrain = (text: string) =>
    brain(async function* () {
        yield* frames.answer(text);
    });

type Turns = Array<
    (request: HarnessStreamRequest) => HarnessStreamEvent[] | Promise<HarnessStreamEvent[]>
>;

// One transport, two sides. The side whose transcript carries the fork task as a USER message is
// the branch; everything else is the requester's run. The last turn of a side repeats, which is
// how a third request (a run that outlives its script) still answers honestly.
const routed = (sides: { owner: Turns; branch: Turns }): HarnessStream => {
    const taken = { owner: 0, branch: 0 };

    return async function* stream(request) {
        const isBranch = request.messages.some(
            (message) => message.role === 'user' && message.content === 'branch task'
        );
        const side = isBranch ? 'branch' : 'owner';
        const turns = sides[side];
        const turn = turns[taken[side]] ?? turns[turns.length - 1];

        taken[side] += 1;

        for (const frame of await turn(request)) yield frame;
    };
};

const toolContents = (messages: readonly unknown[]): string[] =>
    (messages as Array<{ role: string; content?: string }>)
        .filter((message) => message.role === 'tool')
        .map((message) => message.content ?? '');

const textContents = (messages: readonly unknown[]): string[] =>
    (messages as Array<{ content?: string }>).map((message) => message.content ?? '');

const contentsByRole = (messages: readonly unknown[], role: string): string[] =>
    (messages as Array<{ role: string; content?: string }>)
        .filter((message) => message.role === role)
        .map((message) => message.content ?? '');

// The refusal every write door gives a branch run (./harness.ts `branchFamilyWriteRefusal`), and
// the refusal a branch ADDRESS gets from `threadSend` (./harness.ts `postThreadMessage`). Written
// out here rather than imported: these are model-facing sentences, and retyping them turns a
// wording change into a visible decision instead of a silent one.
const branchRefusal = (door: string, branchId: string, ownerThreadId: string): string =>
    `A threadFork branch cannot use ${door} from inside its run: "${branchId}" is a private branch of ` +
    `conversation "${ownerThreadId}", so anything it sends, delegates or releases lands in that conversation — ` +
    'which is the pollution the fork was asked to avoid. Read what you need with threadRead or agentResult by ' +
    'the branch id, and answer in this turn. To let a branch write anyway, the run that FORKS must pass ' +
    'allowFamilyWrites: true on that threadFork call; a branch cannot grant it to itself.';

const branchAddressRefusal = (branchId: string, ownerThreadId: string, running: boolean): string =>
    `Thread "${branchId}" is a threadFork branch, not a conversation: it has no queue and no turn ` +
    'to wake, so threadSend cannot post into it. It is' +
    (running ? ' still ' : ' ') +
    'working, and its transcript is readable with threadRead by that id; the answer (including the ' +
    'partial of a branch that was cancelled, failed or timed out) is readable with agentResult using ' +
    `it as invocationId. To speak with the conversation that owns it, address "${ownerThreadId}" (see threadList).`;

// The exact row a live branch contributes to the MODEL roster (./harness.ts `threadRecordOfBranch`
// through `branchRosterRows`): the branch id is the row's `id`, its `invocationId` AND its
// `branchId` key, `sequence` is its position in the retained ledger plus one, and `ownerThreadId`
// is the conversation that forked it.
const branchRow = (branchId: string, ownerThreadId: string, status: 'running' | 'idle') => ({
    id: branchId,
    agent: 'writer',
    origin: 'host',
    branchId,
    status,
    sequence: 1,
    ownerThreadId,
    invocationId: branchId
});

// Let the real timers and the mailbox settle until a state is reached. Nothing here fakes a clock:
// a fork is background work, and each wait is "has this happened", asserted AFTER the wait.
const settle = async (until: () => boolean, passes = 400): Promise<void> => {
    for (let pass = 0; pass < passes; pass += 1) {
        if (until()) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    throw new Error('the awaited state was never reached');
};

const gated = (): { promise: Promise<void>; release: () => void } => {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return { promise, release };
};

describe('a threadFork branch and the family-write doors (F1)', () => {
    it('refuses threadSend and threadDelete inside a branch run, and the branch still answers', async () => {
        // The scripted args name a thread that does not exist until the harness is built, so it is
        // read from a closure assigned right after `createThread`.
        let siblingId = 'thread-unknown';

        const writer = harness({
            agents: {
                writer: brain(routed({
                    owner: [
                        () => frames.call('c1', 'threadFork', { input: 'branch task' }),
                        () => frames.answer('owner done')
                    ],
                    branch: [
                        () =>
                            frames.calls([
                                {
                                    id: 'b1',
                                    name: 'threadSend',
                                    arguments: { thread: siblingId, message: 'from the branch' }
                                },
                                { id: 'b2', name: 'threadDelete', arguments: { thread: siblingId } }
                            ]),
                        () => frames.answer('branch done')
                    ]
                }))
            },
            presets: false
        });

        // A HOST thread as the requester, so the requester owns a persistent thread the branch
        // inherits, and a second host thread the branch tries to write into.
        const owner = writer.createThread('writer');
        const sibling = writer.createThread('writer', { ownerThreadId: owner.id });

        siblingId = sibling.id;

        expect((await writer.sendThreadInput(owner.id, 'go')).content).toBe('owner done');

        const [record] = writer.branches();

        expect(record.agent).toBe('writer');
        // The DEFAULT fork carries no `allowFamilyWrites` key: absence IS the `false` default, so
        // the `branch_start` payload of every fork that did not ask keeps its historical key set.
        expect('allowFamilyWrites' in record).toBe(false);
        expect(record.status).toBe('completed');
        expect(record.result?.content).toBe('branch done');

        // Both refusals sit in the branch's OWN transcript, in call order, byte for byte, after the marker
        // that answers the requester's still-pending `threadFork` call.
        expect(toolContents(record.messages)).toEqual([
            BRANCH_SELF_CALL_PLACEHOLDER,
            `Tool "threadSend" failed: ${branchRefusal('threadSend', record.branchId, owner.id)}`,
            `Tool "threadDelete" failed: ${branchRefusal('threadDelete', record.branchId, owner.id)}`
        ]);

        // Isolation HELD: the requester's conversation gained no steering message, and the thread
        // the branch tried to post into and release never started a turn.
        expect(contentsByRole(writer.threadMessages(owner.id), 'user')).toEqual(['go']);
        expect(writer.thread(sibling.id)?.status).toBe('idle');
        expect(textContents(writer.threadMessages(sibling.id))).toEqual([]);
    });

    it('refuses delegate inside a branch run, ahead of the rank rule', async () => {
        const writer = harness({
            agents: {
                writer: brain(routed({
                    owner: [
                        () => frames.call('c1', 'threadFork', { input: 'branch task' }),
                        () => frames.answer('owner done')
                    ],
                    branch: [
                        () => frames.call('b1', 'delegate', { agent: 'helper', input: 'child' }),
                        () => frames.answer('branch done')
                    ]
                })),
                helper: echoBrain('child answer')
            },
            presets: false
        });

        const owner = writer.createThread('writer');

        await writer.sendThreadInput(owner.id, 'go');

        const [record] = writer.branches();

        // ONE tool message: the branch refusal, NOT the rank sentence — the guard runs first, and a
        // branch that may not delegate at all should not be sent to the roster by a complaint about
        // a target it could not have used.
        expect(toolContents(record.messages)).toEqual([
            BRANCH_SELF_CALL_PLACEHOLDER,
            `Tool "delegate" failed: ${branchRefusal('delegate', record.branchId, owner.id)}`
        ]);

        // Isolation HELD at the roster, not just in the transcript. Every registered agent's
        // DEFAULT conversation is a roster row from construction (`agent:<name>`, `origin:
        // 'agent'`, never run), so the honest claim is the narrow one: the helper gained no
        // DELEGATED CHILD conversation — no `thread-N` row with `origin: 'agent'` anywhere — and
        // its default conversation was never written into. Had the guard sat behind the rank rule,
        // `delegateFor` would have run `runAgent` and minted exactly such a row.
        expect(writer.threads().filter((row) => row.agent === 'helper')).toEqual([
            { id: 'agent:helper', agent: 'helper', origin: 'agent', status: 'idle', sequence: 2 }
        ]);
        expect(
            writer.threads().filter((row) => row.origin === 'agent' && !row.id.startsWith('agent:'))
        ).toEqual([]);
        expect(textContents(writer.threadMessages('agent:helper'))).toEqual([]);
    });

    it('lets an opted-in branch post into its family, attributed with the branch id', async () => {
        let targetId = 'thread-unknown';

        const writer = harness({
            agents: {
                writer: brain(routed({
                    owner: [
                        () =>
                            frames.call('c1', 'threadFork', {
                                input: 'branch task',
                                allowFamilyWrites: true
                            }),
                        () => frames.answer('owner done')
                    ],
                    branch: [
                        () => frames.call('b1', 'threadSend', { thread: targetId, message: 'from the branch' }),
                        () => frames.answer('branch done')
                    ]
                })),
                // A DIFFERENT agent owns the target conversation, so the opted-in send lands on a
                // dormant thread of its own rather than on a conversation the sender is standing in
                // (this agent's own default is refused by the own-default rule, not by the guard).
                reporter: echoBrain('child answer')
            },
            presets: false
        });

        const owner = writer.createThread('writer');
        const child = writer.createThread('reporter', { ownerThreadId: owner.id });

        targetId = child.id;

        expect((await writer.sendThreadInput(owner.id, 'go')).content).toBe('owner done');

        const [record] = writer.branches();

        // The flag is recorded on the branch, and it is the ONLY thing that changed this fork's
        // behaviour: the send was allowed, so the branch's tool row is the send receipt.
        expect(record.allowFamilyWrites).toBe(true);

        expect(toolContents(record.messages)).toEqual([
            BRANCH_SELF_CALL_PLACEHOLDER,
            JSON.stringify({
                threadId: child.id,
                delivered: 'started',
                sender: 'writer',
                senderThreadId: owner.id
            })
        ]);

        // THE ATTRIBUTION (C4). The delivered prompt names the branch beside the conversation that
        // forked it, so the receiver can tell a branch's message from its owner's own turn and can
        // follow it with `threadRead branch-N`. The receipt keeps `senderThreadId` = the persistent
        // owner, which is the address the receiver may actually post back to.
        expect(textContents(writer.threadMessages(child.id))).toEqual([
            `from agent "writer" (thread ${owner.id}, branch ${record.branchId}):\nfrom the branch`,
            'child answer'
        ]);

        // The requester's own conversation stayed clean: an opted-in send goes where it was
        // addressed, not into the transcript the fork was forked from.
        expect(contentsByRole(writer.threadMessages(owner.id), 'user')).toEqual(['go']);
    });

    it('lists a running branch in the model roster, keeps it out of the host roster, and refuses it as a postbox', async () => {
        const branchGate = gated();
        const ownerGate = gated();

        const writer = harness({
            agents: {
                writer: brain(routed({
                    owner: [
                        () => frames.call('c1', 'threadFork', { input: 'branch task' }),
                        // The requester is PARKED inside its second request, not answering: a run
                        // that concludes releases its still-running branches (./harness.ts
                        // `releaseBranchesForScope`), so the roster window only exists while the
                        // requester is still in a turn.
                        async () => {
                            await ownerGate.promise;

                            return frames.answer('owner done');
                        }
                    ],
                    branch: [
                        async () => {
                            await branchGate.promise;

                            return frames.answer('branch done');
                        }
                    ]
                }))
            },
            presets: false
        });

        const owner = writer.createThread('writer');
        const running = writer.sendThreadInput(owner.id, 'go');

        await settle(() => writer.branches().length === 1 && writer.branches()[0].status === 'running');

        const [record] = writer.branches();

        // THE MODEL ROSTER lists the live branch, so the id `threadFork` handed back is a row the
        // caller can find — readable, and never actable.
        expect(writer.runtime.threadList(owner.id).threads.filter((row) => row.branchId !== undefined)).toEqual([
            branchRow(record.branchId, owner.id, 'running')
        ]);
        expect(writer.runtime.threadList(owner.id).actOn?.includes(record.branchId)).toBe(false);

        // THE HOST ROSTER still excludes branch runs: a branch is an invocation, not a conversation,
        // and that sibling contract is unchanged by the model-plane rows.
        expect(writer.threads().some((row) => row.id === record.branchId)).toBe(false);

        // `harness.thread('branch-N')` resolves the same row, and `branchId` is the KEY a consumer
        // branches on rather than a `branch-` prefix match.
        expect(writer.thread(record.branchId)).toEqual(branchRow(record.branchId, owner.id, 'running'));

        // A branch address is not a postbox, and the door says what it IS instead of the old false
        // "never created, or it was deleted".
        expect(() =>
            writer.runtime.threadSend(undefined, owner.id, { thread: record.branchId, message: 'hi' })
        ).toThrow(branchAddressRefusal(record.branchId, owner.id, true));

        ownerGate.release();
        branchGate.release();
        await running;
    });

    it('cancels a live fork by the branch id the fork reported, and echoes the ids it released', async () => {
        const branchGate = gated();
        const ownerGate = gated();

        const writer = harness({
            agents: {
                writer: brain(routed({
                    owner: [
                        () => frames.call('c1', 'threadFork', { input: 'branch task' }),
                        async () => {
                            await ownerGate.promise;

                            // C3 — the requester names the branch id the fork REPORTED, the id it
                            // was told to keep, and never has to remember the call id.
                            return frames.call('c2', 'toolCancel', {
                                callId: writer.branches()[0].branchId
                            });
                        },
                        () => frames.answer('owner done')
                    ],
                    branch: [
                        async () => {
                            await branchGate.promise;

                            return frames.answer('branch done');
                        }
                    ]
                }))
            },
            presets: false
        });

        const owner = writer.createThread('writer');
        const running = writer.sendThreadInput(owner.id, 'go');

        await settle(() => writer.branches().length === 1 && writer.branches()[0].status === 'running');

        const [record] = writer.branches();

        ownerGate.release();

        // The receipt is what proves the resolution: it exists as soon as the control is answered,
        // while the branch task itself only terminalises once its own gated stream can observe the
        // abort.
        await settle(() =>
            toolContents(writer.threadMessages(owner.id)).some((content) => content.includes('"cancelled":true'))
        );

        branchGate.release();
        await running;

        // C3 + M6 — `toolCancel` resolved the BRANCH id to the call that owns it, and the receipt
        // echoes the ids of the work it released: the branch id doubles as the `threadRead` address
        // and the `agentResult` invocationId, and `threadId` names the conversation the release
        // happened in.
        const cancel = toolContents(writer.threadMessages(owner.id)).find((content) =>
            content.includes('"cancelled":true')
        );

        expect(cancel).toBe(
            JSON.stringify({
                cancelled: true,
                callId: 'c1',
                name: 'threadFork',
                branchId: record.branchId,
                invocationId: record.branchId,
                threadId: owner.id
            })
        );

        // The branch is terminal, and its id is still a readable address that refuses a post.
        expect(writer.branches()[0].status).toBe('cancelled');
        expect(() =>
            writer.runtime.threadSend(undefined, owner.id, { thread: record.branchId, message: 'hi' })
        ).toThrow(branchAddressRefusal(record.branchId, owner.id, false));
    });

    it('reads a released conversation from its own lineage, and refuses a stranger', async () => {
        const writer: Harness = harness({
            agents: { writer: echoBrain('unused') },
            presets: false
        });

        const parent = writer.createThread('writer');
        const child = writer.createThread('writer', { ownerThreadId: parent.id });
        const stranger = writer.createThread('writer');

        writer.setThreadMessages(child.id, [
            { role: 'user', content: 'kept' },
            { role: 'assistant', content: 'answer' }
        ]);

        expect(writer.deleteThread(child.id)).toEqual({
            deleted: child.id,
            removedThreadIds: [child.id],
            removedInvocationIds: [],
            removedBranchIds: []
        });

        const kept = ['kept', 'answer'];

        // The host view keeps the retained transcript (the readability half of a soft delete).
        expect(textContents(writer.threadMessages(child.id))).toEqual(kept);

        // F1 — the lineage that owns the released conversation can still read it. The old sentence
        // ("no conversation can read it") sent exactly the caller that released it to a host door
        // it does not have, while issue 0027's flow — read the child, then release it — is the
        // reason `threadDelete` exists at all.
        expect(textContents(writer.threadMessages(child.id, parent.id))).toEqual(kept);

        // A conversation outside that lineage still gets the refusal, now naming who CAN read it.
        expect(() => writer.threadMessages(child.id, stranger.id)).toThrow(
            `Thread "${child.id}" is inactive (deleted); its transcript is retained, but it is no longer part of this ` +
                "session's roster, and it is not in your lineage, so threadRead cannot answer it from a conversation " +
                '(see threadList). The conversation that released it — and any conversation in that lineage — still ' +
                'can, and a host can always read it by id.'
        );
    });
});

// ---------------------------------------------------------------------------
// C3 / R1 (2026-11-27) — THE CREATION-TIME POINTER IN THE REQUESTER'S LEDGER.
//
// A fork hands its caller a `branch-N` id, and until now that id lived only in memory:
// `branchRecords` is deliberately outside `HarnessSnapshot`, the pending placeholder that names
// the call id is request-only, and a requester whose run ends while the branch is in flight
// (a turn cap, a stop, a crash) kept an assistant turn with an unsettled `threadFork` call and
// NOTHING that named the branch. The engine now commits one standalone row at creation, carrying
// `{ branchId, threadId, callId }` and saying when the answer arrives.
//
// What the four cases below pin, in order:
//   (a) the row is committed AT CREATION — before the branch has produced anything — carries all
//       three ids, travels in the requester's very next model request, and is readable from the
//       requester's own ledger THROUGH `threadRead` while the branch is still running;
//   (b) the settle-time receipt is unchanged — the branch's answer still lands as the CALL's tool
//       message, at the call's position, with the historical `{ branchId, threadId, content }`;
//   (c) `toolCancel` with the call id still CANCELS (not `alreadySettled`), which is the proof
//       that the row did not settle the call — settledness here is one committed `role:'tool'`
//       row carrying the call id, and the pointer is a `role:'system'` row with no call key;
//   (d) a fresh run of the same conversation still finds the ids — the row is committed, not branch
//       state — and `toolCancel` addressed by the branch id resolves across runs through the branch
//       ledger, answering `alreadySettled` for a fork that has settled. The pointer is written once
//       and rewritten by nothing: no settle, no cancel, no later run touches it.
// ---------------------------------------------------------------------------

describe('the threadFork creation-time pointer (C3/R1)', () => {
    // The note the engine writes, spelled out here rather than imported: it is model-facing
    // prose, so a wording change has to be a visible decision in this file, not an imported
    // constant that keeps a stale pin green.
    const pointerNote =
        'The pointer written when this threadFork call created a branch. Not the call\'s result: the branch\'s answer arrives as THIS call\'s tool result when the branch settles, and toolCancel with callId or branchId releases the call while it runs. threadRead on branchId reads the branch transcript, agentResult with branchId as invocationId pages its answer or partial, and threadId equals branchId because a branch is an ephemeral conversation, not a roster thread.';

    // The whole row, in the engine's key order. `event` is PAST TENSE on purpose: the row stays
    // true after the branch settles and its result row lands next to it.
    const pointerRow = (callId: string, branchId: string): string =>
        JSON.stringify({
            event: 'branch_started',
            name: 'threadFork',
            callId,
            branchId,
            threadId: branchId,
            note: pointerNote
        });

    const systemContents = (messages: readonly unknown[]): string[] =>
        (messages as Array<{ role: string; content?: string }>)
            .filter((message) => message.role === 'system')
            .map((message) => message.content ?? '');

    it('commits the pointer when the branch is created, and carries it in the next request', async () => {
        const branchGate = gated();
        const ownerGate = gated();

        // The requester's SECOND request is the one that has to carry the row: it is built after
        // the fork dispatch, while the branch is still running and the requester is parked.
        const secondRequest: HarnessStreamRequest[] = [];
        let ownerId = 'thread-unknown';

        const writer = harness({
            agents: {
                writer: brain(routed({
                    owner: [
                        () => frames.call('c1', 'threadFork', { input: 'branch task' }),
                        async (request) => {
                            secondRequest.push(request);
                            await ownerGate.promise;

                            // THE LEDGER READ, through the real tool, from the conversation that
                            // forked, while the branch is still running. The pointer is a `system`
                            // row, so the read names `includeSystem` — the same opt-in every other
                            // system-seed read takes. `role: 'system'` keeps the page on the
                            // pointer alone: without it the ASSISTANT row carrying this very
                            // `threadRead` call would answer too, because `regex` searches raw
                            // tool arguments and the pattern is inside them (the self-match
                            // `threadRead` reports instead of hiding).
                            return frames.call('c2', 'threadRead', {
                                thread: ownerId,
                                includeSystem: true,
                                role: 'system',
                                regex: 'branch_started'
                            });
                        },
                        () => frames.answer('owner done')
                    ],
                    branch: [
                        async () => {
                            await branchGate.promise;

                            return frames.answer('branch done');
                        }
                    ]
                }))
            },
            presets: false
        });

        const owner = writer.createThread('writer');
        ownerId = owner.id;

        const running = writer.sendThreadInput(owner.id, 'go');

        await settle(() => writer.branches().length === 1 && writer.branches()[0].status === 'running');

        const [record] = writer.branches();
        const row = pointerRow('c1', record.branchId);

        // (a1) THE COMMIT, at creation, with the branch still running and nothing produced yet.
        // [user turn, assistant `threadFork` call, the pointer] — the pointer is the third row,
        // written after the call it names and before any result for it.
        expect(writer.threadMessages(owner.id).map((message) => message.role)).toEqual([
            'user',
            'assistant',
            'system'
        ]);
        expect(systemContents(writer.threadMessages(owner.id))).toEqual([row]);

        // (a2) THE NEXT REQUEST CARRIES IT. A committed row the model never sees would only
        // satisfy a test; the requester learns the branch id from its own transcript, on the turn
        // it is asked again, with no tool call at all.
        await settle(() => secondRequest.length > 0);

        expect(
            secondRequest[0]!.messages.some(
                (message) => message.role === 'system' && message.content === row
            )
        ).toBe(true);

        ownerGate.release();

        // (a3) AND THE SAME ROW COMES BACK THROUGH `threadRead`, addressed at its own ledger.
        await settle(() =>
            toolContents(writer.threadMessages(owner.id)).some((content) => content.includes('branch_started'))
        );

        const page = JSON.parse(
            toolContents(writer.threadMessages(owner.id)).find((content) =>
                content.includes('"contentBudget"')
            ) ?? ''
        ) as {
            total: number;
            matched: number;
            messages: Record<string, unknown>[];
        };

        // FOUR rows: the user turn, the assistant row holding the `threadFork` call, the pointer,
        // and the assistant row holding THIS `threadRead` call (committed before the tool runs).
        // ONE match: the pointer. `matchedFields` names the field that hit — `content`, not
        // `toolArguments` — which is the reader saying plainly which row it matched on.
        expect(page.total).toBe(4);
        expect(page.matched).toBe(1);
        expect(page.messages).toEqual([
            {
                index: 2,
                role: 'system',
                content: row,
                contentLength: row.length,
                contentOffset: 0,
                contentHasMore: false,
                matchedFields: ['content']
            }
        ]);

        branchGate.release();
        await running;
    });

    it('still delivers the settle-time answer as the call result, beside the pointer', async () => {
        const writer = harness({
            agents: {
                writer: brain(routed({
                    owner: [
                        () => frames.call('c1', 'threadFork', { input: 'branch task' }),
                        () => frames.answer('owner done')
                    ],
                    branch: [() => frames.answer('branch done')]
                }))
            },
            presets: false
        });

        const owner = writer.createThread('writer');

        await writer.sendThreadInput(owner.id, 'go');

        const [record] = writer.branches();

        // (b) THE RECEIPT IS UNCHANGED. The branch's answer is the CALL's tool message, at the
        // call's own position, with the historical key set — the pointer did not take its slot,
        // did not pre-settle it, and did not move it. `resultInsertIndex` splices the result back
        // after the assistant block, so the ledger reads call, answer, pointer: the pointer stays
        // where it was written, which is the honest order of events.
        const messages = writer.threadMessages(owner.id);

        expect(messages.map((message) => [message.role, (message as { toolCallId?: string }).toolCallId ?? ''])).toEqual([
            ['user', ''],
            ['assistant', ''],
            ['tool', 'c1'],
            ['system', ''],
            // The requester's own closing turn, which is what the branch's delivery rode in on.
            ['assistant', '']
        ]);
        expect(toolContents(messages)).toEqual([
            JSON.stringify({
                branchId: record.branchId,
                threadId: record.branchId,
                content: 'branch done'
            })
        ]);
        expect(systemContents(messages)).toEqual([pointerRow('c1', record.branchId)]);
    });

    it('still cancels the fork by its call id from inside the same run', async () => {
        const branchGate = gated();
        const ownerGate = gated();

        const writer = harness({
            agents: {
                writer: brain(routed({
                    owner: [
                        () => frames.call('c1', 'threadFork', { input: 'branch task' }),
                        async () => {
                            await ownerGate.promise;

                            // (c) THE CALL ID, not the branch id — the form that would answer
                            // `alreadySettled: true` if the pointer row had settled the call.
                            return frames.call('c2', 'toolCancel', { callId: 'c1' });
                        },
                        () => frames.answer('owner done')
                    ],
                    branch: [
                        async () => {
                            await branchGate.promise;

                            return frames.answer('branch done');
                        }
                    ]
                }))
            },
            presets: false
        });

        const owner = writer.createThread('writer');

        const running = writer.sendThreadInput(owner.id, 'go');

        await settle(() => writer.branches().length === 1 && writer.branches()[0].status === 'running');

        const [record] = writer.branches();

        ownerGate.release();

        await settle(() =>
            toolContents(writer.threadMessages(owner.id)).some((content) => content.includes('"cancelled":true'))
        );

        const [cancel] = toolContents(writer.threadMessages(owner.id)).filter((content) =>
            content.includes('"cancelled":true')
        );

        // A real release, with no `alreadySettled` key: the live task was found and cancelled, and
        // the receipt still echoes the ids it always echoed.
        expect(cancel).toBe(
            JSON.stringify({
                cancelled: true,
                callId: 'c1',
                name: 'threadFork',
                branchId: record.branchId,
                invocationId: record.branchId,
                threadId: owner.id
            })
        );

        branchGate.release();
        await running;

        expect(writer.branches()[0].status).toBe('cancelled');
    });

    it('keeps the ids readable from every later run, and answers a cross-run cancel honestly', async () => {
        const branchGate = gated();

        // The branch id is minted by the engine, and the SECOND run has to name it exactly — it is
        // the id the pointer put in this conversation's own ledger.
        let branchAddress = 'branch-pending';

        const writer = harness({
            agents: {
                writer: brain(routed({
                    owner: [
                        () => frames.call('c1', 'threadFork', { input: 'branch task' }),
                        // The requester CONCLUDES while the branch is still gated, so its run ends
                        // and releases the branch it still owns (`releaseBranchesForScope`) — the
                        // window in which a caller used to lose every trace of the fork.
                        () => frames.answer('owner done'),
                        // A SECOND RUN of the same conversation, addressed to the branch id it can
                        // now read back out of its own ledger.
                        () => frames.call('c3', 'toolCancel', { callId: branchAddress }),
                        () => frames.answer('later done')
                    ],
                    branch: [
                        async () => {
                            await branchGate.promise;

                            return frames.answer('branch done');
                        }
                    ]
                }))
            },
            presets: false
        });

        const owner = writer.createThread('writer');

        const first = writer.sendThreadInput(owner.id, 'go');

        await settle(() => writer.branches().length === 1 && writer.branches()[0].status === 'running');

        const [record] = writer.branches();

        branchAddress = record.branchId;

        // Let the branch finish. Its answer is delivered into the requester's own conversation, and
        // that delivery starts a FOLLOW-UP RUN of the same conversation — the first run that never
        // made the fork call, which is exactly the situation the pointer exists for. The scripted
        // owner turns are consumed in order, so that run is owner turn 2 (the `toolCancel`).
        branchGate.release();

        await first;

        // (d1) THE LEDGER SURVIVES ITS OWN RUN. The pointer is a committed transcript row, not
        // branch state (`branchRecords` is outside `HarnessSnapshot`), so every later run of this
        // conversation starts already knowing the branch id, the call id, and where the answer is.
        expect(systemContents(writer.threadMessages(owner.id))).toEqual([
            pointerRow('c1', record.branchId)
        ]);

        // (d2) AND THE CANCEL DOOR ANSWERS THE SAME FACT IT ALWAYS ANSWERED. The follow-up run
        // cancels with the BRANCH id read out of the pointer. That address still resolves across
        // runs — the branch ledger, not the run-scoped `branchCallIds` map, carries the pair — and
        // the fork has settled, so the door reports `alreadySettled` rather than cancelling. A
        // `Tool "…" failed:` head would mean a throw; this is a tool result.
        await settle(() =>
            toolContents(writer.threadMessages(owner.id)).some((content) =>
                content.includes('"alreadySettled":true')
            )
        );

        expect(
            toolContents(writer.threadMessages(owner.id)).find((content) =>
                content.includes('"alreadySettled":true')
            )
        ).toBe(
            JSON.stringify({
                cancelled: true,
                callId: 'c1',
                name: 'threadFork',
                alreadySettled: true,
                branchId: record.branchId,
                invocationId: record.branchId,
                threadId: owner.id
            })
        );

        // (d3) THE RUN AFTER THAT STILL READS THE SAME ROW — the pointer is written ONCE, at
        // creation, and is not rewritten by the settle or by a later cancel.
        const second = await writer.sendThreadInput(owner.id, 'cancel the branch you forked');

        expect(second.content).toBe('later done');
        expect(systemContents(writer.threadMessages(owner.id))).toEqual([
            pointerRow('c1', record.branchId)
        ]);
    });
});

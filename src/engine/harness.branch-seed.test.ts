// F1b (2026-11-27) — M5: what a branch's SEEDED transcript says about its requester's unsettled calls.
//
// A `threadFork` snapshot is taken at the fork instant, so every tool call of the requester that was
// still UNSETTLED at that instant is seeded into the branch as a synthetic tool row. Two facts about
// that seed are pinned here:
//
//   - the branch's OWN creating call is not a failure. It is unsettled at the fork instant by
//     construction, and answering it with the non-success placeholder ("This placeholder is NOT a
//     successful result") tells the branch model that its own creation failed. That reading is the
//     documented root of the phantom relay: a branch re-enacted the parent's pending intent and sent
//     its own fork brief back to its owner with `threadSend`. The creating call therefore carries a
//     self-describing marker — this call started the branch now executing, its result is delivered to
//     the owner when this branch settles, treat it as satisfied — and the GENERIC placeholder stays for
//     every OTHER unsettled call (./core/branch.ts `BRANCH_PENDING_PLACEHOLDER`, whose wording is
//     pinned by ./core/branch.test.ts:113);
//   - a placeholder is a PLACEHOLDER, not a record. When one of those sibling calls later commits in the
//     requester — a result, a failure or a cancellation, whatever row the requester's ledger received —
//     the live branch's copy of that row is rewritten with the committed content. The branch's terminal
//     snapshot then carries it, because `finishBranch` re-captures the branch transcript at terminal
//     (./harness.ts:10459).
//
// WHAT IS NOT BACKFILLED, and why: rows already committed at the fork instant were seeded verbatim and
// are correct; the creating call keeps its marker instead of the fork receipt, because "this is the call
// that started you" is the fact the branch needs and quoting the receipt back invites another fork; and
// a SETTLED branch is frozen — its record stopped following the transcript, so a call that commits after
// the branch ended never reaches it.
//
// WHY THE TIMING IS PROVABLE. A branch transcript is observable from a test in exactly two places: the
// provider request the branch run serves, and the branch record. Every assertion below therefore reads
// one of those AFTER a gate only the test controls has opened — the sibling's tool promise resolves
// while the branch is parked inside a tool call of its own — so the committed content provably existed
// in the requester before the branch could have captured it. Nothing fakes a clock.
//
// Harness-generated ids (`thread-N`, `branch-N`, `call_branch-N_k`) are READ, never hardcoded: a row's
// id is asserted THROUGH `record.toolCallIds`, the retained origin -> branch correspondence.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from './index';
import type {
    Harness,
    HarnessBranchRecord,
    HarnessMessage,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from './index';
// The generic non-success placeholder is asserted verbatim, so it is read from its own module (the
// convention ./harness.fork.test.ts uses), never retyped.
import { BRANCH_PENDING_PLACEHOLDER } from './core/branch';

// M5 (1) — the self-describing marker for the branch's own creating call. Written as a LITERAL here, on
// purpose: a red test must not import the constant it exists to establish, or its first run fails at
// import rather than at the assertion. ./core/branch.ts exports the same string as
// `BRANCH_SELF_CALL_PLACEHOLDER`; `core/branch.test.ts` pins the constant itself, this file pins the
// behaviour that places it.
const SELF_CALL_MARKER =
    'This is the call that started the branch now executing (branch-self-call). No result was ' +
    'committed for it yet because its answer is this branch: the result is delivered to the ' +
    'conversation that started it when this branch settles. Treat this call as satisfied - do not ' +
    're-issue it, and do not relay this brief to anyone else.';

const frames = {
    answer: (text: string): HarnessStreamEvent[] => [
        { type: 'text', delta: text },
        { type: 'done', stopReason: 'stop', toolCalls: [] }
    ],
    calls: (toolCalls: Array<{ id: string; name: string; arguments: unknown }>): HarnessStreamEvent[] => [
        {
            type: 'done',
            stopReason: 'tool_calls',
            toolCalls: toolCalls.map((toolCall) => ({
                ...toolCall,
                // `call.arguments` is a JSON STRING on the wire (the provider's shape).
                arguments: JSON.stringify(toolCall.arguments)
            }))
        }
    ]
};

const brain = (stream: HarnessStream) => agent({ model: 'merge/ds4-flash', stream });

type Turns = Array<
    (request: HarnessStreamRequest) => HarnessStreamEvent[] | Promise<HarnessStreamEvent[]>
>;

// One transport, two sides (`routed` in ./harness.branch-writes.test.ts): the side whose transcript
// carries the fork brief as a USER message is the branch, everything else is the requester's run. The
// last turn of a side repeats, so a run that outlives its script still answers honestly.
const routed = (sides: { owner: Turns; branch: Turns }): HarnessStream => {
    const taken = { owner: 0, branch: 0 };

    return async function* stream(request) {
        const side = branchSide(request) ? 'branch' : 'owner';
        const turns = sides[side];
        const turn = turns[taken[side]] ?? turns[turns.length - 1];

        taken[side] += 1;

        // `turn(request)` returns the async GENERATOR a scripted turn is; iterating it (rather than
        // awaiting it and then looping) is what keeps its frames.
        yield* turn(request);
    };
};

// The fork brief is the branch's root user message, and only a branch transcript carries it (the
// requester's transcript holds the fork CALL, never the brief as a user turn).
const branchSide = (request: HarnessStreamRequest): boolean =>
    request.messages.some((message) => message.role === 'user' && message.content === 'branch task');

// Every request the branch run served, in order. A request's `messages` is the PROJECTION built for that
// one provider call — a snapshot, not the live array — so a captured request reads the branch transcript
// as of the moment the request was made. That is exactly what makes it the seam for "what the branch run
// actually saw", and exactly why a request captured BEFORE an event cannot show that event.
const branchRequests = (seen: readonly HarnessStreamRequest[]): HarnessStreamRequest[] =>
    seen.filter(branchSide);

// The same transport with a capture attached, so a test can read the transcript a run SERVED without
// changing what it answers. `route` is an async generator: it must be ITERATED (`yield* route(...)`),
// never awaited and then looped, or the one generator comes back spent and the run sees an empty stream.
const capture = (
    route: HarnessStream,
    seen: HarnessStreamRequest[]
): HarnessStream =>
    async function* stream(request) {
        seen.push(request);
        yield* route(request);
    };

const toolRows = (
    messages: readonly HarnessMessage[]
): Array<Extract<HarnessMessage, { role: 'tool' }>> =>
    messages.filter((message): message is Extract<HarnessMessage, { role: 'tool' }> => message.role === 'tool');

const toolContents = (messages: readonly HarnessMessage[]): string[] =>
    toolRows(messages).map((message) => message.content);

// The SEEDED rows only. A branch transcript also carries the rows for the branch's OWN tool calls, and
// those are not what this file is about; filtering by the requester's tool names keeps every assertion
// exact while naming the exclusion.
const seededContents = (
    messages: readonly HarnessMessage[],
    requesterToolNames: readonly string[]
): string[] =>
    toolRows(messages)
        .filter((message) => requesterToolNames.includes(message.name))
        .map((message) => message.content);

// Canonical entries carry a minted `messageId` (context T1, ./core/message-id.ts) — an ADDRESS, like a
// timestamp, not content. Stripping it deeply keeps every expected value here exactly what it was, the
// way ./harness.fork.test.ts does for the same reason.
const withoutIds = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutIds);

    if (typeof value === 'object' && value !== null) {
        const entries: [string, unknown][] = [];

        for (const [key, child] of Object.entries(value)) {
            if (key === 'messageId') continue;
            entries.push([key, withoutIds(child)]);
        }

        return Object.fromEntries(entries);
    }

    return value;
};

// A tool whose execution is a promise the TEST controls, so a call can be held unsettled across a fork
// and committed at an exact moment (`holdTool` in ./harness.fork.test.ts parks a branch the same way).
// `visibility: 'core'` keeps it declared without a discovery round, and its description/tags are inert
// here because core tools are never scored.
const gated = (name: string) => {
    let release: (value: unknown) => void = () => undefined;
    const promise = new Promise<unknown>((resolve) => {
        release = resolve;
    });

    return {
        promise,
        release,
        descriptor: tool({
            description: 'A test tool that parks until the test releases it.',
            tags: ['test'],
            visibility: 'core',
            execute: () => promise
        })
    };
};

// The retained record of one branch, read THROUGH its id (the records `branches()` hands out are
// detached clones, so a snapshot taken early never shows a later transition).
const branchOf = (writer: Harness, branchId: string): HarnessBranchRecord => {
    const record = writer.branch(branchId);

    if (record === undefined) throw new Error(`branch "${branchId}" is not recorded`);

    return record;
};

// Let the real timers and the mailbox settle until a state is reached (`settle` in
// ./harness.branch-writes.test.ts). Nothing fakes a clock: each wait is "has this happened", asserted
// AFTER the wait.
const settle = async (until: () => boolean, passes = 600): Promise<void> => {
    for (let pass = 0; pass < passes; pass += 1) {
        if (until()) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    throw new Error('the awaited state was never reached');
};

describe("what a branch seed says about its requester's unsettled calls (M5)", () => {
    it('seeds the creating call with a self-describing marker, not the non-success placeholder', async () => {
        const seen: HarnessStreamRequest[] = [];
        const route = routed({
            owner: [
                () => frames.calls([{ id: 'c1', name: 'threadFork', arguments: { input: 'branch task' } }]),
                () => frames.answer('owner done')
            ],
            branch: [() => frames.answer('branch done')]
        });

        const writer = harness({
            agents: { writer: brain(capture(route, seen)) },
            presets: false
        });

        const home = writer.createThread('writer');

        expect((await writer.sendThreadInput(home.id, 'go')).content).toBe('owner done');

        const record = writer.branches()[0];

        // ONE tool row in the seeded transcript: the requester's only call was the fork itself. It is the
        // MARKER, and the failure wording the branch used to read is gone from its transcript entirely —
        // which is the point, because the branch model decides whether its own creation succeeded by
        // reading exactly these rows.
        expect(toolContents(record.messages)).toEqual([SELF_CALL_MARKER]);
        expect(JSON.stringify(record.messages)).not.toContain(BRANCH_PENDING_PLACEHOLDER.threadFork);

        // The marker answers the SAME row the placeholder used to answer: the remapped id of the creating
        // call, under the creating tool's name. `messageId` is a minted ADDRESS (core/message-id.ts), not
        // content, so the row is compared with it stripped — the `withoutIds` convention of
        // ./harness.fork.test.ts.
        const origin = record.toolCallIds.find((entry) => entry.origin === 'c1');

        expect(origin).toBeDefined();
        expect(withoutIds(toolRows(record.messages))).toEqual([
            { role: 'tool', content: SELF_CALL_MARKER, toolCallId: origin!.branch, name: 'threadFork' }
        ]);

        // And it is in the transcript the branch run actually served, not only in the audit copy.
        const [firstBranchRequest] = branchRequests(seen);

        expect(firstBranchRequest).toBeDefined();
        expect(toolContents(firstBranchRequest.messages)).toEqual([SELF_CALL_MARKER]);

        // The requester's own row is untouched by any of this: the marker lives in the branch copy, and
        // the parent ledger still holds the real fork receipt.
        expect(toolContents(writer.threadMessages(home.id))).toEqual([
            JSON.stringify({ branchId: record.branchId, threadId: record.branchId, content: 'branch done' })
        ]);
    });

    it('backfills a live branch placeholder with the sibling result the requester committed after the fork', async () => {
        // The requester's tool names, i.e. exactly the rows that were SEEDED into the branch (the
        // branch's own `park` receipt is a later row of its own making).
        const requesterTools = ['slow', 'threadFork'];
        const slow = gated('slow');
        const park = gated('park');
        const seen: HarnessStreamRequest[] = [];

        const route = routed({
            owner: [
                // ONE assistant turn, two calls: a sibling that stays unsettled across the fork, and the
                // fork itself. Both are pending at the snapshot instant, which is the situation the
                // placeholder exists for.
                () =>
                    frames.calls([
                        { id: 'c1', name: 'slow', arguments: {} },
                        { id: 'c2', name: 'threadFork', arguments: { input: 'branch task' } }
                    ]),
                () => frames.answer('owner done')
            ],
            branch: [
                // The branch parks inside a tool call of its own, so it is still LIVE when the sibling
                // settles; its second turn answers.
                () => frames.calls([{ id: 'b1', name: 'park', arguments: {} }]),
                () => frames.answer('branch done')
            ]
        });

        const writer = harness({
            agents: { writer: brain(capture(route, seen)) },
            tools: { slow: slow.descriptor, park: park.descriptor },
            presets: false
        });

        const home = writer.createThread('writer');
        const turn = writer.sendThreadInput(home.id, 'go');

        // THE FORK INSTANT. The branch is live, its requester's turn is still in flight, and the
        // sibling's promise has not resolved — so the requester's ledger holds no `slow` row yet.
        await settle(
            () => writer.branches().length === 1 && writer.thread(home.id)?.status === 'running'
        );

        const branchId = writer.branches()[0].branchId;

        expect(writer.branch(branchId)?.status).toBe('running');
        expect(toolRows(writer.threadMessages(home.id))).toEqual([]);

        // THE SEED: the sibling carries the GENERIC placeholder, the creating call carries its own
        // marker, and row order is call order.
        expect(toolContents(branchOf(writer, branchId).messages)).toEqual([
            BRANCH_PENDING_PLACEHOLDER.threadFork,
            SELF_CALL_MARKER
        ]);
        expect(toolContents(branchRequests(seen)[0]!.messages)).toEqual([
            BRANCH_PENDING_PLACEHOLDER.threadFork,
            SELF_CALL_MARKER
        ]);

        // THE SIBLING SETTLES while the branch is still parked — the moment the backfill has to act,
        // because the branch is live and its transcript is the running one.
        slow.release({ sibling: 'committed' });

        await settle(() => toolRows(writer.threadMessages(home.id)).length === 1);

        // The requester holds the real row... while the branch RECORD stays exactly as it was: its
        // `messages` is the creation-time clone, re-captured only at terminal, and this branch is still
        // running. That is the frozen-record disclosure in its other half. The branch's OWN live copy is
        // not readable from a host seam at this instant — the only request it has served so far was built
        // BEFORE this commit, and a request's `messages` is the projection of the moment it was built — so
        // the proof that the rewrite happened in the RUNNING transcript is the branch's next request, read
        // below, and the terminal snapshot that followed it.
        expect(withoutIds(toolRows(writer.threadMessages(home.id)))).toEqual([
            { role: 'tool', content: JSON.stringify({ sibling: 'committed' }), toolCallId: 'c1', name: 'slow' }
        ]);
        expect(toolContents(branchOf(writer, branchId).messages)).toEqual([
            BRANCH_PENDING_PLACEHOLDER.threadFork,
            SELF_CALL_MARKER
        ]);

        // THE BRANCH RESUMES and settles.
        park.release(undefined);

        await settle(() => writer.branch(branchId)?.status === 'completed');

        const record = branchOf(writer, branchId);

        // The terminal snapshot captured the live transcript: the sibling's COMMITTED result, then the
        // creating call's marker, still in call order. (The branch's own `park` receipt is the next row of
        // that transcript; it is not one of the seeded rows this case is about.)
        expect(seededContents(record.messages, requesterTools)).toEqual([
            JSON.stringify({ sibling: 'committed' }),
            SELF_CALL_MARKER
        ]);

        // Identity survives the rewrite: only `content` changed, so the row still answers the remapped id
        // of the sibling call and still names the sibling tool.
        const sibling = record.toolCallIds.find((entry) => entry.origin === 'c1');

        expect(sibling).toBeDefined();
        expect(withoutIds(toolRows(record.messages)[0])).toEqual({
            role: 'tool',
            content: JSON.stringify({ sibling: 'committed' }),
            toolCallId: sibling!.branch,
            name: 'slow'
        });

        // The proof does not rest on the audit copy alone: the branch request that carried the park
        // result to its answer held the rewritten sibling row too. The branch's OWN row (its parked
        // tool's receipt) is excluded by name, because this case is about the seeded rows and its
        // serialization is not the contract under test.
        const lastBranchRequest = branchRequests(seen).at(-1);

        expect(lastBranchRequest).toBeDefined();
        expect(seededContents(lastBranchRequest!.messages, requesterTools)).toEqual([
            JSON.stringify({ sibling: 'committed' }),
            SELF_CALL_MARKER
        ]);

        // The requester's ledger is the whole record of its turn: the sibling's row, then the fork receipt
        // that arrived when the branch settled.
        await turn;

        expect(toolRows(writer.threadMessages(home.id)).map((message) => ({
            name: message.name,
            content: message.content
        }))).toEqual([
            { name: 'slow', content: JSON.stringify({ sibling: 'committed' }) },
            {
                name: 'threadFork',
                content: JSON.stringify({ branchId, threadId: branchId, content: 'branch done' })
            }
        ]);
    });

    it('keeps the generic placeholder for an unsettled call that never settled, and freezes it with the branch', async () => {
        // The requester's three tool names: all three rows of the seed (the branch's own `park` receipt is
        // excluded from the assertions below, exactly as in the case above).
        const requesterTools = ['slow', 'threadFork', 'later'];
        const slow = gated('slow');
        const later = gated('later');
        const park = gated('park');

        const route = routed({
            owner: [
                () =>
                    frames.calls([
                        { id: 'c1', name: 'slow', arguments: {} },
                        { id: 'c2', name: 'threadFork', arguments: { input: 'branch task' } },
                        { id: 'c3', name: 'later', arguments: {} }
                    ]),
                () => frames.answer('owner done')
            ],
            branch: [
                () => frames.calls([{ id: 'b1', name: 'park', arguments: {} }]),
                () => frames.answer('branch done')
            ]
        });

        const writer = harness({
            agents: { writer: brain(route) },
            tools: { slow: slow.descriptor, later: later.descriptor, park: park.descriptor },
            presets: false
        });

        const home = writer.createThread('writer');
        const turn = writer.sendThreadInput(home.id, 'go');

        await settle(() => writer.branches().length === 1);

        const branchId = writer.branches()[0].branchId;

        // Three unsettled calls, seeded as three rows: sibling placeholder, self marker, sibling
        // placeholder. The generic wording stays the answer for every call that is NOT the branch's own —
        // for those, "no result was committed" is simply true.
        expect(toolContents(branchOf(writer, branchId).messages)).toEqual([
            BRANCH_PENDING_PLACEHOLDER.threadFork,
            SELF_CALL_MARKER,
            BRANCH_PENDING_PLACEHOLDER.threadFork
        ]);

        slow.release({ sibling: 'committed' });
        park.release(undefined);

        await settle(() => writer.branch(branchId)?.status === 'completed');

        // The sibling that settled during the branch's life reads as its real result; the creating call
        // keeps its marker; and the call that was STILL unsettled when the branch ended keeps the honest
        // generic placeholder — the requester's turn is parked on it at this very moment.
        expect(seededContents(branchOf(writer, branchId).messages, requesterTools)).toEqual([
            JSON.stringify({ sibling: 'committed' }),
            SELF_CALL_MARKER,
            BRANCH_PENDING_PLACEHOLDER.threadFork
        ]);

        // A call that commits AFTER the branch settled never reaches the frozen record: the branch
        // transcript is a snapshot of a moment, not a subscription.
        later.release({ later: 'committed' });

        await turn;

        expect(seededContents(branchOf(writer, branchId).messages, requesterTools)).toEqual([
            JSON.stringify({ sibling: 'committed' }),
            SELF_CALL_MARKER,
            BRANCH_PENDING_PLACEHOLDER.threadFork
        ]);
        expect(toolRows(writer.threadMessages(home.id)).map((message) => message.name)).toEqual([
            'slow',
            'threadFork',
            'later'
        ]);
    });
});

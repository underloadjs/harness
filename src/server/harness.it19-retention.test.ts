// IT19 acceptance suite — "all turns must be recorded; they must not be destroyed whether the
// agent is cancelled or stopped; deleted marks the thread INACTIVE (undiscoverable by the session
// tooling, still discoverable by a shell that reads the directory); the only way a thread is
// permanently gone is that the SESSION was deleted."
//
// Every group below is named after the acceptance criterion (issue §9, as revised by the review)
// it is the evidence for, so a failure names the criterion it breaks:
//
//   AC1  a cancelled delegation retains every committed message, and `threadRead.total`
//        is at least `cancelledAtMessage` (the headline regression: it was `total: 1`
//        against `cancelledAtMessage: 23`);
//   AC2  thread STATUS and invocation STATUS stay separate enums, and `idle` is no longer
//        ambiguous — the record carries a machine-readable `stopReason` while `status`
//        stays in the unchanged vocabulary;
//   AC3  every non-concluded terminal state yields a machine-readable `stopReason`
//        (`caller-released` / `user-stopped` / `timeout` / `api-error`), and the same cause
//        is on the INVOCATION record as seen through `agentResult`;
//   AC4  `threadSend` names which operation it performed — `queued` / `started` / `resumed` —
//        and refuses a `user-stopped` target, a plugin-parked target, and an `inactive` one;
//   AC5  a parent whose run has ended is NOT woken by a late child: the account is owed and
//        paid at the top of the parent's own next turn, and a synthesized interrupted
//        placeholder for that call is upgraded IN PLACE (one answer per call, no duplicate
//        account, no extra parent turn);
//   AC6  deleted-but-retained: `threadDelete` marks `inactive` + `inactiveAt`, the session
//        tooling stops discovering it, an agent-facing `threadRead` refuses it, the
//        transcript BYTES are still on disk (asserted by reading the persisted v2 shards with
//        `fs`, the way a shell user would), and a host send revives it and clears the mark;
//   AC7  repair honesty: exactly one synthesized `role:'tool'` result per unanswered call, it
//        says "cancelled or interrupted" (never "server restarted"), and a second repair
//        pass changes nothing.
//
// Harness patterns are the neighbouring suites', reused rather than reinvented:
//   - scripted transports / `answer` / `callTool` / `brain` / `flush`: ./harness.thread-runtime.test.ts:127-158;
//   - a tool whose `execute` returns a promise, which keeps a delegated child live long enough
//     to be cancelled: ./harness.delegation.test.ts:1300-1335;
//   - a `streamedThenParked` child (streams, then never finishes its request): ./harness.delegation.test.ts:207;
//   - the real `SessionStore` + `HarnessPersistence` over a temp directory: ./server/threads.test.ts,
//     and the repo-root `Temp/` root ./server/thread-stop-reference.test.ts:216-238 uses (repo
//     policy: never the OS temp).
//
// Clock policy: NO fake timers anywhere in this file. Every expectation is gated on a promise
// (a transport that waits on a deferred, a tool that waits on a deferred) or on `waitUntil`,
// which polls a predicate across macrotasks and FAILS with a named state instead of letting the
// 15 s vitest timeout be the first signal. Nothing here depends on wall-clock ordering except
// AC3's `timeoutMs`, which is a bound the harness itself enforces.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '../engine/index';
import type {
    HarnessAgentResultSnapshot,
    HarnessMessage,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    HarnessThreadRecord,
    HarnessThreadStatus
} from '../engine/index';
import {
    SYNTHESIZED_INTERRUPTED_TOOL_RESULT_TEXT,
    findInterruptedToolCalls,
    repairInterruptedToolCalls
} from '../engine/core/transcript-repair';
import { HarnessPersistence } from './persistence';
// v2 layout readers (./server/persistence-test-helpers.ts): this suite pins what survives ON
// DISK after a soft delete, so it reads the shards directly instead of through `load()`.
import { readPersistedDocument } from './persistence-test-helpers';
import { createHarnessRegistry } from './harnesses';
import { SessionStore } from './sessions';
import type { HarnessPreset } from './harnesses/types';

// ---------------------------------------------------------------------------
// Fixtures (the neighbouring suites' vocabulary, byte-compatible)
// ---------------------------------------------------------------------------

const deferred = <T = void>() => {
    let settle!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolve) => {
        settle = resolve;
    });

    return { promise, resolve: settle };
};

// Drain microtasks plus one macrotask so the harness chain reaches its next resting point.
const flush = async (): Promise<void> => {
    for (let pass = 0; pass < 16; pass += 1) await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (let pass = 0; pass < 16; pass += 1) await Promise.resolve();
};

// Poll a condition across macrotasks. A contract that never lands fails HERE, naming the state,
// rather than at the test timeout — that is what makes every "the run reached state X" gate in
// this file non-flaky without pinning a clock.
const waitUntil = async (
    condition: () => boolean,
    describe: string | (() => string)
): Promise<void> => {
    // A TIME box, not an attempt count: how many macrotasks fit in a second is a runner detail,
    // and under `vitest` a delegated round costs hundreds of ms (each tool is compiled from its
    // own captured source). Past the box the failure names the state that never arrived.
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
        if (condition()) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }

    throw new Error(
        `Condition never became true within 10s: ${typeof describe === 'function' ? describe() : describe}`
    );
};

const scripted = (turns: HarnessStreamEvent[][], seen?: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;

    return async function* stream(request) {
        seen?.push(request);
        const frames = turns[index] ?? turns[turns.length - 1];
        index += 1;
        for (const frame of frames) yield frame;
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const callTool = (id: string, name: string, args: unknown): HarnessStreamEvent[] => [
    {
        type: 'done',
        stopReason: 'tool_calls',
        toolCalls: [{ id, name, arguments: JSON.stringify(args) }]
    }
];

// One assistant turn that BOTH says something (so it is a committed, readable message) and asks
// for a tool. AC1 and AC7 need the committed text to be distinguishable from the tool output.
const sayThenCall = (
    text: string,
    id: string,
    name: string,
    args: unknown
): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    {
        type: 'done',
        stopReason: 'tool_calls',
        toolCalls: [{ id, name, arguments: JSON.stringify(args) }]
    }
];

const brain = (stream: HarnessStream, extra: Record<string, unknown> = {}): ReturnType<typeof agent> =>
    agent({ model: 'merge/ds4-flash', stream, ...extra });

// A conversation that answers as soon as its request is released — the target shape AC4's
// `queued` receipt needs (the run must be PROVABLY mid-request when the send lands).
const gatedAnswer = (text: string) => {
    const release = deferred<void>();
    let arrivals = 0;

    const stream: HarnessStream = async function* () {
        arrivals += 1;
        await release.promise;
        yield { type: 'text', delta: text };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };

    return { stream, release, arrivals: () => arrivals };
};

// A transport that fails the request outright — the producer of the `api-error` stop reason.
const throwingTransport = (message = 'provider exploded'): HarnessStream =>
    async function* () {
        throw new Error(message);
    };

// ---------------------------------------------------------------------------
// Read helpers (what a caller can actually observe)
// ---------------------------------------------------------------------------

// `threadRead`'s page, object-or-JSON-string (a manual `executeTool` hands back the tool's own
// value, a transcript tool message carries its JSON text). Mirrors ./harness.thread-read.test.ts:89.
type Page = {
    thread: { id: string; agent: string; origin: string; status: string; sequence: number };
    total: number;
    matched: number;
    offset: number;
    limit: number;
    hasMore: boolean;
    messages: Record<string, any>[];
};

const pageOf = (value: unknown): Page =>
    typeof value === 'string' ? (JSON.parse(value) as Page) : (value as Page);

// The `researcher` conversation this harness minted, with the invocation id the roster joins it to.
const childOf = (instance: any): HarnessThreadRecord & { invocationId: string } => {
    const threads = instance.threads() as (HarnessThreadRecord & { invocationId?: string })[];

    // The DELEGATED conversation is the minted host row (origin 'host', ownerThreadId). The
    // `agent:researcher` row is the agent's STANDING default conversation, which exists before
    // any child runs, so it is only a fallback and only when it carries the invocation join.
    const child =
        threads.find(
            (entry) =>
                entry.agent === 'researcher' && entry.origin === 'host' && entry.invocationId !== undefined
        ) ?? threads.find((entry) => entry.agent === 'researcher' && entry.invocationId !== undefined);

    if (child === undefined || child.invocationId === undefined) {
        // The roster is printed because the two cases differ: no row at all (the delegation never
        // minted a conversation) vs a row without a join (the run never started or never archived).
        throw new Error(
            `no delegated researcher conversation in the roster: ${JSON.stringify(
                (instance.threads() as unknown[]).map((entry) => ({
                    id: (entry as HarnessThreadRecord).id,
                    agent: (entry as HarnessThreadRecord).agent,
                    status: (entry as HarnessThreadRecord).status,
                    invocationId: (entry as HarnessThreadRecord).invocationId,
                    stopReason: (entry as HarnessThreadRecord).stopReason
                }))
            )}`
        );
    }

    return { ...child, invocationId: child.invocationId };
};

// The durable ledger row for one invocation, through the model-facing `agentResult` door.
const agentRowOf = async (
    instance: any,
    agentName: string,
    invocationId: string
): Promise<Record<string, any>> =>
    (await instance.executeTool('agentResult', { agent: agentName, invocationId })) as Record<
        string,
        any
    >;

// The same row as the SNAPSHOT writes it — the durable half of "the cause travels with the run".
const snapshotRowOf = (
    instance: any,
    invocationId: string
): HarnessAgentResultSnapshot | undefined =>
    (instance.snapshot().agentResults ?? []).find(
        (row: HarnessAgentResultSnapshot) => row.invocationId === invocationId
    );

// One transcript's `role:content` view — enough to pin a transcript shape without pinning ids.
const shapeOf = (messages: readonly unknown[]): string[] =>
    messages.map((message) => {
        const entry = message as { role?: string; content?: unknown };

        return `${String(entry.role)}:${typeof entry.content === 'string' ? entry.content : ''}`;
    });

// Every `tool` message answering one call id. The "exactly one answer for the call" assertions
// count these, so the guard is against BOTH failure modes: none (a destroyed outcome) and two
// (a reprinted account beside the placeholder).
const resultsForCall = (messages: readonly unknown[], callId: string) =>
    messages.filter(
        (message) =>
            (message as { role?: string; toolCallId?: string }).role === 'tool' &&
            (message as { toolCallId?: string }).toolCallId === callId
    ) as { role: string; content: string; toolCallId: string; messageId?: string }[];

// Attach the handlers immediately so an aborted run's rejection is never unhandled.
const probe = <T>(promise: Promise<T>) => {
    const state: { status: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } = {
        status: 'pending'
    };

    promise.then(
        (value) => {
            state.status = 'resolved';
            state.value = value;
        },
        (error) => {
            state.status = 'rejected';
            state.error = error;
        }
    );

    return state;
};

// ---------------------------------------------------------------------------
// The delegated child every AC1/AC2/AC3 scenario shares
// ---------------------------------------------------------------------------
//
// `researcher` commits THREE real tool rounds (each an assistant turn plus its tool result) and
// then asks for `hang`, whose promise the test alone settles — the shape ./harness.delegation.test.ts:1300-1335
// uses to keep a child live long enough to be interrupted. Eight messages are therefore committed
// before the park: the delegated prompt, three (assistant, tool) pairs, and the assistant turn that
// asks for the parked call. Two DOORS end that run, and both are exercised because they stamp
// different causes:
//
//   stoppedChild()      — the HOST halts the child conversation with `stopThread` while the call is
//                         parked → `status: 'stopped'`, `stopReason: 'user-stopped'`, invocation
//                         `cancelled` with `cancelledAtMessage` naming how far it got;
//   releasedChild()     — the PARENT releases its own call with `toolCancel` → `status: 'idle'`,
//                         `stopReason: 'caller-released'`, same forensic count.
//
// Gating rule (no sleeps, no fake timers): the parent's SECOND request awaits the child's third
// committed round from inside the transport. That is safe here and only here — the `delegate` call
// has already parked, so the child's run keeps progressing in its own chain while the parent's next
// request is open (./harness.delegation.test.ts:1842-1908 relies on the same non-blocking park).

const CHILD_NOTES = ['first note', 'second note', 'third note'] as const;

const interruptedChild = () => {
    const committed: string[] = [];
    const thirdRound = deferred<void>();
    let releaseHang!: (value: string) => void;
    const hang = new Promise<string>((resolve) => {
        releaseHang = resolve;
    });

    const note = tool({
        description: 'Record one fact in the transcript.',
        tags: ['test'],
        // `visibility: 'core'`: a session tool that is not core is REGISTERED but not ENABLED, and
        // the round would answer "Tool \"x\" is registered but not enabled" instead of a real turn.
        visibility: 'core',
        // A tool's single argument is the ToolContext; the model's arguments ride on `parameters`.
        execute: (context: { parameters?: { text?: string } }) => {
            const text = String(context?.parameters?.text ?? '');
            committed.push(text);
            if (committed.length === CHILD_NOTES.length) thirdRound.resolve();

            return `noted:${text}`;
        }
    });

    const hangTool = tool({
        description: 'Never answers until the test releases it.',
        tags: ['test'],
        visibility: 'core',
        execute: () => hang
    });

    const researcher = brain(
        scripted([
            ...CHILD_NOTES.map((text, index) =>
                sayThenCall(text, `r${String(index + 1)}`, 'note', { text })
            ),
            sayThenCall('half an answer', 'h1', 'hang', {})
        ])
    );

    return { committed, thirdRound, hang, releaseHang, note, hangTool, researcher };
};

// AC1's scenario: a host thread delegates, the child parks, and the HOST stops the child's
// conversation. The parent stays alive and answers, which is what makes its child's retained
// transcript readable through the session's own tools afterwards.
const stoppedChild = async () => {
    const child = interruptedChild();

    const writer = harness({
        agents: {
            writer: brain(
                scripted([
                    callTool('c1', 'delegate', { agent: 'researcher', input: 'find facts' }),
                    answer('closing')
                ])
            ),
            researcher: child.researcher
        },
        tools: { note: child.note, hang: child.hangTool },
        presets: false
    });

    // A `createThread` parent mints a CHILD THREAD (origin 'host', ownerThreadId) rather than
    // re-entering `agent:researcher` (./harness.delegation.test.ts:1367-1385) — and minting a
    // thread is also what registers the `threadRead`/`threadSend`/`threadDelete` tools AC1 reads with.
    const alpha = writer.createThread('writer', { label: 'Alpha' });
    const running = writer.sendThreadInput(alpha.id, 'go');

    running.catch(() => undefined);

    // GATE: the minted child conversation has committed all four rounds and is parked inside
    // `hang`, so the stop below provably lands on a conversation with four turns in hand.
    let row: (HarnessThreadRecord & { invocationId?: string }) | undefined;

    await waitUntil(
        () => {
            row = (writer.threads() as (HarnessThreadRecord & { invocationId?: string })[]).find(
                (entry) => entry.agent === 'researcher' && entry.origin === 'host'
            );

            return (
                row !== undefined &&
                row.invocationId !== undefined &&
                String(threadTail(writer, row)) === 'half an answer'
            );
        },
        () =>
            `the child committed ${String(CHILD_NOTES.length + 1)} turns and parked — notes ${JSON.stringify(
                child.committed
            )}, roster ${JSON.stringify(
                (writer.threads() as HarnessThreadRecord[]).map((entry) => ({
                    id: entry.id,
                    origin: entry.origin,
                    status: entry.status
                }))
            )}, transcript ${JSON.stringify(
                row === undefined
                    ? []
                    : (writer.threadMessages(row.id) as HarnessMessage[]).map((message) => String(message.content))
            )}`
    );

    expect(writer.stopThread(row.id, 'operator stop')).toBe(true);

    // The released call carries the child's terminal account back to the parent, which then answers.
    const parentAnswer = await running;

    child.releaseHang('released');

    await waitUntil(
        () => writer.thread(row.id)?.status !== 'running',
        `the stopped conversation "${row.id}" comes to rest`
    );

    return {
        writer,
        alpha,
        parentAnswer,
        childId: row.id,
        invocationId: String(row.invocationId),
        committed: child.committed
    };
};

// AC2/AC3(`caller-released`): the SAME child, ended by the parent releasing its own call.
// Host-driven (`writer('go')`) because that is the shape whose released call reports
// `callCancelled` (./harness.delegation.test.ts:1842-1908); the child is the agent's default
// conversation `agent:researcher`.
const releasedChild = async () => {
    const child = interruptedChild();
    let arrivals = 0;

    const writerAgent = brain(async function* () {
        arrivals += 1;

        if (arrivals === 1) {
            yield* callTool('c1', 'delegate', { agent: 'researcher', input: 'find facts' });

            return;
        }

        if (arrivals === 2) {
            // The park is what makes this gate safe: the child keeps running while THIS request
            // is open, so the release provably lands after the third committed round.
            await child.thirdRound.promise;
            yield* callTool('c2', 'toolCancel', { callId: 'c1' });

            return;
        }

        yield* answer('closing');
    });

    const writer = harness({
        agents: { writer: writerAgent, researcher: child.researcher },
        tools: { note: child.note, hang: child.hangTool },
        presets: false
    });

    const parentAnswer = await writer('go');

    child.releaseHang('released');

    const row = (writer.threads() as (HarnessThreadRecord & { invocationId?: string })[]).find(
        (entry) => entry.agent === 'researcher'
    )!;

    await waitUntil(
        () => writer.thread(row.id)?.status !== 'running',
        `the released conversation "${row.id}" comes to rest`
    );

    return {
        writer,
        parentAnswer,
        childId: row.id,
        invocationId: String(row.invocationId),
        committed: child.committed
    };
};

// The last committed message's text, which is what the gates above compare against.
const threadTail = (instance: any, row: HarnessThreadRecord): string => {
    const messages = instance.threadMessages(row.id) as HarnessMessage[];
    const last = messages[messages.length - 1];

    return String(last?.content ?? '');
};

// ===========================================================================
// AC1 — a cancelled delegation retains every committed message
// ===========================================================================

describe('AC1 — a cancelled delegation retains every committed message', () => {
    it('AC1.1 threadRead.total is at least cancelledAtMessage (the headline regression: 1 vs 23)', async () => {
        const scene = await stoppedChild();
        const { writer, childId, invocationId } = scene;

        const record = await agentRowOf(writer, 'researcher', invocationId);
        const page = pageOf(
            await writer.executeTool('threadRead', { thread: childId, limit: 100 })
        );

        expect(record.status).toBe('cancelled');

        // THE ACCEPTANCE RELATION. Before the fix `total` was 1 while the ledger counted 23
        // committed messages: the transcript had been destroyed under the run, so the count the
        // caller was handed named bytes that no longer existed.
        expect(page.total >= record.cancelledAtMessage).toBe(true);

        // Deterministic for this script, so the pair is pinned exactly as well as related: the
        // child committed 3 note rounds plus one assistant turn, and the repair added exactly one
        // synthesized result for the parked call (AC7).
        expect({
            total: page.total,
            cancelledAtMessage: record.cancelledAtMessage
        }).toEqual({ total: 9, cancelledAtMessage: 8 });

        // `threadRead` is reading the WHOLE retained transcript, not a page of a destroyed one.
        expect(page.total).toBe(writer.threadMessages(childId).length);
        expect(page.hasMore).toBe(false);
    });

    it('AC1.2 every turn the child had committed is still readable in its transcript', async () => {
        const scene = await stoppedChild();
        const { writer, childId } = scene;

        const messages = writer.threadMessages(childId) as HarnessMessage[];

        // user + (assistant+tool) x3 + the assistant that asked for the parked call + its
        // synthesized answer. Nothing between them was destroyed by the cancellation.
        expect(messages.map((message) => message.role)).toEqual([
            'user',
            'assistant',
            'tool',
            'assistant',
            'tool',
            'assistant',
            'tool',
            'assistant',
            'tool'
        ]);

        const texts = messages.map((message) => String(message.content));

        for (const note of CHILD_NOTES) {
            expect(texts).toContain(note);
        }

        // The tool OUTPUT of each committed round survived too — the turn is replayable history,
        // not a text-only remnant.
        expect(texts).toEqual([
            // The delegated prompt is the child's first message, and it survives: it is the record
            // of what the parent asked and never got an answer to.
            'find facts',
            'first note',
            'noted:first note',
            'second note',
            'noted:second note',
            'third note',
            'noted:third note',
            'half an answer',
            SYNTHESIZED_INTERRUPTED_TOOL_RESULT_TEXT
        ]);

        // And the caller of the released call still gets its account: the `toolCancel` envelope
        // carried the child's terminal record, so the release never read as "the child vanished".
        const page = pageOf(await writer.executeTool('threadRead', { thread: childId, limit: 100 }));
        expect(page.messages.length).toBe(9);
    });

    it('AC1.3 the retained transcript is durable, not just live memory', async () => {
        const scene = await stoppedChild();
        const { writer, childId, invocationId } = scene;

        const snapshot = writer.snapshot();
        const row = (snapshot.threads ?? []).find(
            (thread: { id: string }) => thread.id === childId
        ) as { id: string; messages: HarnessMessage[]; stopReason?: string } | undefined;

        // The snapshot the host persists carries the retained bytes AND the cause, so a restart
        // restores the cancelled conversation rather than an empty one.
        expect(row?.messages.length).toBe(9);
        expect(row?.stopReason).toBe('user-stopped');
        expect(snapshotRowOf(writer, invocationId)?.stopReason).toBe('user-stopped');
    });

    it('AC1.4 the same retention holds when the CALLER releases the call (idle + caller-released)', async () => {
        // The other door that ends a delegation: nobody halted the conversation, the parent
        // released its own call. AC1's invariant is about the TRANSCRIPT, so it must hold for
        // both causes, and `idle` alone must no longer be read as "the child answered".
        const scene = await releasedChild();
        const { writer, childId, invocationId } = scene;

        expect(shapeOf(writer.threadMessages(childId) as HarnessMessage[])).toEqual([
            'user:find facts',
            'assistant:first note',
            'tool:noted:first note',
            'assistant:second note',
            'tool:noted:second note',
            'assistant:third note',
            'tool:noted:third note',
            `assistant:half an answer`,
            `tool:${SYNTHESIZED_INTERRUPTED_TOOL_RESULT_TEXT}`
        ]);

        const record = await agentRowOf(writer, 'researcher', invocationId);

        expect({
            status: record.status,
            partialContent: record.partialContent,
            cancelledAtMessage: record.cancelledAtMessage
        }).toEqual({
            status: 'cancelled',
            partialContent: 'half an answer',
            cancelledAtMessage: 8
        });
    });
});

// ===========================================================================
// AC2 — thread status and invocation status stay separate enums, and an
//       interrupted `idle` conversation is no longer ambiguous
// ===========================================================================

// The vocabularies, pinned as VALUES (a rename in ../types/index.ts:2964 or :3457 breaks this file).
const THREAD_STATUSES: readonly HarnessThreadStatus[] = ['idle', 'running', 'paused', 'stopped'];
const INVOCATION_STATUSES: readonly HarnessAgentResultSnapshot['status'][] = [
    'completed',
    'failed',
    'cancelled'
];
const RUN_STOP_REASONS = [
    'caller-released',
    'user-stopped',
    'timeout',
    'turn-cap',
    'budget-exhausted',
    'api-error',
    'retries-exhausted',
    'parent-closed',
    'plugin-parked'
] as const;

describe('AC2 — thread status, invocation status and stopReason stay separate vocabularies', () => {
    it('AC2.1 a cancelled delegation records stopReason: caller-released while status stays in the unchanged vocabulary', async () => {
        const scene = await releasedChild();
        const { writer, childId, invocationId } = scene;

        const record = writer.thread(childId) as HarnessThreadRecord;

        expect(record.stopReason).toBe('caller-released');
        expect(THREAD_STATUSES).toContain(record.status);

        // A cancelled child comes to rest at `idle` (the caller released the CALL; nobody halted
        // the conversation), and `idle` alone used to be the whole story.
        expect(record.status).toBe('idle');

        const row = await agentRowOf(writer, 'researcher', invocationId);

        expect(INVOCATION_STATUSES).toContain(row.status);
        expect(row.status).toBe('cancelled');
    });

    it('AC2.2 the cause vocabulary is disjoint from BOTH status vocabularies, so no field substitutes for the other', () => {
        // The provider-level `HarnessStopReason` ('stop' | 'length' | 'tool_calls') is a third,
        // orthogonal vocabulary and none of these three words name a run-level halt either.
        expect(RUN_STOP_REASONS.filter((reason) => THREAD_STATUSES.includes(reason as HarnessThreadStatus))).toEqual([]);
        expect(
            RUN_STOP_REASONS.filter((reason) => INVOCATION_STATUSES.includes(reason as HarnessAgentResultSnapshot['status']))
        ).toEqual([]);
        expect(THREAD_STATUSES.filter((status) => INVOCATION_STATUSES.includes(status as HarnessAgentResultSnapshot['status']))).toEqual([]);
    });

    it('AC2.3 the marker is keyed to the EXIT, not the status: a concluded run leaves none behind', async () => {
        // The pair that makes `stopReason` readable rather than merely present: a conversation
        // that DID answer must not carry a stale cause into its next turn.
        const target = harness({
            agents: { writer: brain(scripted([answer('answered')])) },
            presets: false
        });
        const thread = target.createThread('writer');

        await target.sendThreadInput(thread.id, 'go');

        expect(target.thread(thread.id)).toMatchObject({ status: 'idle' });
        expect(target.thread(thread.id)?.stopReason).toBeUndefined();
    });
});

// ===========================================================================
// AC3 — every non-concluded terminal state yields a machine-readable cause
// ===========================================================================

describe('AC3 — every non-concluded terminal state carries a machine-readable stopReason', () => {
    it('AC3.1 caller-released: toolCancel on a live delegate puts the cause on the thread AND on the invocation record', async () => {
        const scene = await releasedChild();
        const { writer, childId, invocationId } = scene;

        expect(writer.thread(childId)?.stopReason).toBe('caller-released');

        // AC3 names `agentResult` as the door. The ledger row is the run's own account, so the
        // caller of a released child can branch on the CAUSE without string-matching an error.
        const row = await agentRowOf(writer, 'researcher', invocationId);

        expect(row.stopReason).toBe('caller-released');
    });

    it('AC3.2 user-stopped: a host stopThread stamps the cause on both records', async () => {
        const target = gatedAnswer('never arrives');
        const writer = harness({ agents: { writer: brain(target.stream) }, presets: false });
        const thread = writer.createThread('writer', { label: 'Stopped' });

        const running = probe(writer.sendThreadInput(thread.id, 'long task'));

        // GATE: the run is provably mid-request (the provider call is open, the answer is
        // unreachable) before the stop lands.
        await waitUntil(
            () => writer.thread(thread.id)?.status === 'running' && target.arrivals() === 1,
            'the thread is running and its one request has arrived'
        );

        expect(writer.stopThread(thread.id, 'operator stop')).toBe(true);
        await waitUntil(() => running.status === 'rejected', 'the stopped run rejects');

        expect(writer.thread(thread.id)).toMatchObject({
            status: 'stopped',
            stopReason: 'user-stopped'
        });

        const invocationId = writer.thread(thread.id)?.invocationId;

        expect(invocationId).toBeTypeOf('string');

        const row = await agentRowOf(writer, 'writer', invocationId as string);

        expect(row.status).toBe('cancelled');
        expect(row.stopReason).toBe('user-stopped');
    });

    it('AC3.3 timeout: a delegate bounded by timeoutMs stamps the cause on both records', async () => {
        let releaseHang!: () => void;
        const hang = new Promise<string>((resolve) => {
            releaseHang = resolve;
        });

        const hangTool = tool({
            description: 'Never answers before the deadline.',
            tags: ['test'],
            visibility: 'core',
            execute: () => hang
        });

        const researcher = brain(scripted([sayThenCall('partial child text', 'h1', 'hang', {})]));
        const writer = harness({
            agents: {
                writer: brain(
                    scripted([
                        callTool('c1', 'delegate', {
                            agent: 'researcher',
                            input: 'find facts',
                            timeoutMs: 40
                        }),
                        answer('child timed out')
                    ])
                ),
                researcher
            },
            tools: { hang: hangTool },
            presets: false
        });

        const alpha = writer.createThread('writer', { label: 'Alpha' });

        await writer.sendThreadInput(alpha.id, 'go');
        releaseHang();

        const child = childOf(writer);

        await waitUntil(
            () => writer.thread(child.id)?.stopReason !== undefined,
            `timed-out conversation "${child.id}" records its cause`
        );

        // The clock expired — nobody halted the conversation — so it comes to rest `idle` WITH
        // its cause, the shape `HarnessThreadRecord.stopReason` documents.
        expect(writer.thread(child.id)).toMatchObject({
            status: 'idle',
            stopReason: 'timeout'
        });

        const row = await agentRowOf(writer, 'researcher', child.invocationId);

        expect(row.status).toBe('cancelled');
        expect(row.stopReason).toBe('timeout');

        // The parent still got its structured envelope for the timed-out child, and answered.
        expect(shapeOf(writer.threadMessages(alpha.id)).at(-1)).toBe('assistant:child timed out');
    });

    it('AC3.4 api-error: a transport that throws stamps the cause on both records', async () => {
        const writer = harness({
            // `retry: false` — the SAME setting the server's scripted fixtures pass. Without it a
            // throwing transport is re-sent with backoff, and the run's terminal state arrives on
            // the retry policy's clock rather than the test's.
            agents: { writer: brain(throwingTransport('provider exploded'), { retry: false }) },
            presets: false
        });
        const thread = writer.createThread('writer', { label: 'Failed' });

        const running = probe(writer.sendThreadInput(thread.id, 'go'));

        await waitUntil(() => running.status === 'rejected', 'the failing run rejects');

        expect(String((running.error as Error).message)).toContain('provider exploded');
        expect(writer.thread(thread.id)).toMatchObject({
            status: 'idle',
            stopReason: 'api-error'
        });

        const invocationId = writer.thread(thread.id)?.invocationId;

        expect(invocationId).toBeTypeOf('string');

        const row = await agentRowOf(writer, 'writer', invocationId as string);

        expect(row.status).toBe('failed');
        expect(row.stopReason).toBe('api-error');
    });
});

// ===========================================================================
// AC4 — threadSend names WHICH operation it performed
// ===========================================================================

describe('AC4 — threadSend reports queued / started / resumed and refuses what only a host may revive', () => {
    it('AC4.1 queued: steering a genuinely running target', async () => {
        const target = gatedAnswer('late answer');
        const writer = harness({ agents: { writer: brain(target.stream) }, presets: false });
        const thread = writer.createThread('writer', { label: 'Running' });

        const running = probe(writer.sendThreadInput(thread.id, 'work'));

        await waitUntil(
            () => writer.thread(thread.id)?.status === 'running' && target.arrivals() === 1,
            'the target is mid-request'
        );

        await expect(
            writer.executeTool('threadSend', { thread: thread.id, message: 'steer' })
        ).resolves.toMatchObject({ threadId: thread.id, delivered: 'queued' });

        // Steering started nothing: still exactly one provider request.
        expect(target.arrivals()).toBe(1);

        target.release.resolve();
        await waitUntil(() => running.status === 'resolved', 'the steered run answers');
    });

    it('AC4.2 started: an idle target is woken with the message as its prompt', async () => {
        const target = gatedAnswer('fresh answer');
        const writer = harness({ agents: { writer: brain(target.stream) }, presets: false });
        const thread = writer.createThread('writer', { label: 'Idle' });

        await expect(
            writer.executeTool('threadSend', { thread: thread.id, message: 'wake up' })
        ).resolves.toMatchObject({ threadId: thread.id, delivered: 'started' });

        await waitUntil(() => target.arrivals() === 1, 'the started run reached the provider');
        target.release.resolve();
    });

    it('AC4.3 resumed: a stopped conversation whose run was cut short continues, and the receipt says so', async () => {
        // How this state is reached honestly: the run was cut short by an exhausted provider
        // (idle + `api-error`, a RESUMMABLE cause), and the roster status is then mirrored to
        // `stopped` through the documented lane seam `setThreadStatus` — the exact shape a
        // restored document carries (`HarnessThreadSnapshot` persists `stopped` + `stopReason`).
        const writer = harness({
            // `retry: false` — the SAME setting the server's scripted fixtures pass. Without it a
            // throwing transport is re-sent with backoff, and the run's terminal state arrives on
            // the retry policy's clock rather than the test's.
            agents: { writer: brain(throwingTransport('provider exploded'), { retry: false }) },
            presets: false
        });
        const thread = writer.createThread('writer', { label: 'Interrupted' });

        await expect(writer.sendThreadInput(thread.id, 'first')).rejects.toThrow('provider exploded');

        expect(writer.thread(thread.id)?.stopReason).toBe('api-error');

        writer.setThreadStatus(thread.id, 'stopped');

        const answering = gatedAnswer('second answer');
        const resumeReceipt = writer.executeTool('threadSend', { thread: thread.id, message: 'continue' });

        // The seam that decides is `isResumableStopReason` (./harness.ts:721): a cut-short stop
        // is lifted, so the send does NOT report `started` for a conversation with work in hand.
        await expect(resumeReceipt).resolves.toMatchObject({
            threadId: thread.id,
            delivered: 'resumed'
        });

        // The stop was really lifted and a run really started on the retained transcript.
        expect(writer.thread(thread.id)?.status).toBe('running');

        // The transport for the revived turn is the gated one: swap by re-running with a fresh
        // harness would lose the retained transcript, so release what the send parked on by
        // letting the ORIGINAL throwing transport answer — it throws again, which is fine: the
        // receipt was about the operation, and the second run's failure is its own record.
        answering.release.resolve();
        await waitUntil(
            () => writer.thread(thread.id)?.status !== 'running',
            'the resumed run settles'
        );
    });

    it('AC4.4 refuses a user-stopped target, and queues nothing', async () => {
        const target = gatedAnswer('never arrives');
        const writer = harness({ agents: { writer: brain(target.stream) }, presets: false });
        const thread = writer.createThread('writer', { label: 'Halted' });

        const running = probe(writer.sendThreadInput(thread.id, 'work'));

        await waitUntil(
            () => writer.thread(thread.id)?.status === 'running',
            'the run is live before the stop'
        );

        writer.stopThread(thread.id, 'operator stop');
        await waitUntil(() => running.status === 'rejected', 'the stopped run rejects');

        expect(writer.thread(thread.id)).toMatchObject({
            status: 'stopped',
            stopReason: 'user-stopped'
        });

        const before = writer.threadMessages(thread.id).length;

        await expect(
            writer.executeTool('threadSend', { thread: thread.id, message: 'peer message' })
        ).rejects.toThrow(/is stopped; it cannot receive messages/);

        // A refusal mutates nothing: no queue entry, no transcript append, no run.
        expect(writer.threadMessages(thread.id).length).toBe(before);
        expect(writer.thread(thread.id)?.status).toBe('stopped');
    });

    it('AC4.5 refuses a plugin-parked target, and never lets a message lift the park', async () => {
        let parkOnce = true;
        const writer = harness({
            agents: { writer: brain(scripted([answer('first answer'), answer('second answer')])) },
            plugins: [
                {
                    name: 'park-forever',
                    setup: (api: any) => {
                        api.on('turn.before', () => {
                            if (!parkOnce) return undefined;
                            parkOnce = false;

                            // A `turn.before` STOP is the live producer of `plugin-parked`
                            // (./harness.ts:12042-12055): the park AND the end of the run.
                            return { decision: { action: 'stop', reason: 'plugin budget' } };
                        });
                    }
                }
            ],
            presets: false
        });

        const thread = writer.createThread('writer', { label: 'Parked' });

        await expect(writer.sendThreadInput(thread.id, 'first turn')).rejects.toThrow(
            'plugin budget'
        );

        expect(writer.thread(thread.id)).toMatchObject({
            status: 'stopped',
            stopReason: 'plugin-parked'
        });

        await expect(
            writer.executeTool('threadSend', { thread: thread.id, message: 'peer message' })
        ).rejects.toThrow(/is stopped; it cannot receive messages/);

        expect(writer.thread(thread.id)?.status).toBe('stopped');
    });

    it('AC4.6 refuses an inactive (deleted) target ahead of every status branch', async () => {
        const writer = harness({ agents: { writer: brain(scripted([answer('answer')])) }, presets: false });
        const caller = writer.createThread('writer', { label: 'Caller' });
        const retired = writer.createThread('writer', { label: 'Released' });

        writer.deleteThread(retired.id);

        await expect(
            writer.executeTool('threadSend', { thread: retired.id, message: 'ping' })
        ).rejects.toThrow(/is inactive: it was deleted/);

        // The caller itself is untouched and still addressable.
        expect(writer.thread(caller.id)?.status).toBe('idle');
    });
});

// ===========================================================================
// AC5 — a parent whose run has ended is not woken by a late child
// ===========================================================================

describe('AC5 — a late child result is an owed account, paid once at the top of the parent\'s own next turn', () => {
    // Shared fixture: alpha delegates to a child that has streamed and is parked mid-request; the
    // caller then releases its OWN signal, which cuts alpha's run short with the `delegate` call
    // in flight. Retention keeps alpha's tail (AC1's mechanism), so the parked call is answered by
    // a synthesized placeholder; the child settles LATER and its account is owed.
    const lateChild = async () => {
        const childGate = deferred<void>();
        // `streamedThenParked(..., marker)` (./harness.delegation.test.ts:207): the marker fires
        // at the instant the child's text has left the transport and its request is STILL open —
        // the precise moment the parent may be cut off "with the child's account still in flight".
        const childParked = deferred<void>();

        const researcher = brain(async function* () {
            yield { type: 'text', delta: 'late: the module is fine' };
            childParked.resolve();
            await childGate.promise;
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        });

        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', { agent: 'researcher', input: 'review src/a.ts' }),
                answer('closing')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        const alpha = writer.createThread('writer', { label: 'Alpha' });
        const controller = new AbortController();

        const running = probe(writer.sendThreadInput(alpha.id, 'go', { signal: controller.signal }));

        // GATE, not a sleep: the child's request is open and its account is in flight before the
        // caller releases the parent. (The text is STREAMED, not committed, at this instant — the
        // 0020 distinction — so the transport's own marker, not the transcript, is the proof.)
        await childParked.promise;

        controller.abort();
        await waitUntil(() => running.status === 'rejected', 'the released parent run rejects');

        childGate.resolve();

        const child = childOf(writer);

        await waitUntil(
            () => writer.thread(child.id)?.status !== 'running',
            'the child reaches its terminal state'
        );

        return { writer, alpha, childId: child.id, invocationId: child.invocationId };
    };

    it('AC5.1 the concluded parent is NOT woken: the placeholder waits, and no extra parent turn happens', async () => {
        const scene = await lateChild();
        const { writer, alpha, childId } = scene;

        const parentMessages = writer.threadMessages(alpha.id);
        const assistantTurns = parentMessages.filter((m: HarnessMessage) => m.role === 'assistant').length;

        // The retained tail: the `delegate` call is still in the transcript, answered only by the
        // synthesized interrupted placeholder (AC7's wording), NOT by a woken-up re-report.
        expect(shapeOf(parentMessages)).toEqual([
            'user:go',
            'assistant:',
            `tool:${SYNTHESIZED_INTERRUPTED_TOOL_RESULT_TEXT}`
        ]);

        const [placeholder] = resultsForCall(parentMessages, 'c1');

        expect(placeholder?.content).toBe(SYNTHESIZED_INTERRUPTED_TOOL_RESULT_TEXT);

        // The child IS terminal — the account exists and is owed — and yet the parent took no
        // extra turn and was never started again.
        const childRow = await agentRowOf(writer, 'researcher', scene.invocationId);

        expect(childRow.status).toBe('cancelled');
        expect(writer.thread(alpha.id)?.status).toBe('idle');
        expect(writer.thread(childId)?.status).not.toBe('running');
        expect(
            writer.threadMessages(alpha.id).filter((m: HarnessMessage) => m.role === 'assistant')
                .length
        ).toBe(assistantTurns);
        expect(writer.threadMessages(alpha.id).length).toBe(parentMessages.length);
    });

    it('AC5.2 the placeholder is upgraded IN PLACE at the top of the parent\'s next turn: one answer, no duplicate, no extra turn', async () => {
        const scene = await lateChild();
        const { writer, alpha, invocationId } = scene;

        const before = writer.threadMessages(alpha.id);
        const [beforePlaceholder] = resultsForCall(before, 'c1');

        expect(beforePlaceholder?.messageId).toBeTypeOf('string');

        // The parent's OWN next turn — a host input, not a wake.
        await writer.sendThreadInput(alpha.id, 'continue');

        const after = writer.threadMessages(alpha.id);
        const results = resultsForCall(after, 'c1');

        // EXACTLY ONE answer for `c1`. Two would be the duplicate account this AC forbids; zero
        // would be the destroyed outcome AC1 forbids.
        expect(results.length).toBe(1);

        const [upgraded] = results;

        // Same call id, same position in the transcript, SAME messageId — the placeholder became
        // the account instead of sitting beside it.
        expect(upgraded?.toolCallId).toBe('c1');
        expect(upgraded?.messageId).toBe(beforePlaceholder?.messageId);
        expect(after.indexOf(upgraded!)).toBe(before.indexOf(beforePlaceholder!));

        // And what it now says is the child's real account, not "no recorded outcome".
        const envelope = JSON.parse(String(upgraded?.content)) as Record<string, any>;

        expect({
            agent: envelope.agent,
            invocationId: envelope.invocationId,
            threadId: envelope.threadId,
            status: envelope.status,
            partialContent: envelope.partialContent
        }).toEqual({
            agent: 'researcher',
            invocationId: invocationId,
            threadId: scene.childId,
            status: 'cancelled',
            partialContent: 'late: the module is fine'
        });

        // NO duplicate account on the system channel, and exactly one user + one assistant turn
        // added by the parent's own next turn.
        expect(after.filter((m: HarnessMessage) => m.role === 'system')).toEqual([]);
        expect(
            shapeOf(after).filter((entry) => entry.startsWith('user:') || entry.startsWith('assistant:'))
        ).toEqual(['user:go', 'assistant:', 'user:continue', 'assistant:closing']);
    });
});

// ===========================================================================
// AC6 — deleted-but-retained, including the view a shell user gets
// ===========================================================================

describe('AC6 — a deleted thread is INACTIVE, never destroyed, and still on disk', () => {
    it('AC6.1 threadDelete marks inactive + inactiveAt and removes the conversation from every discovery surface', async () => {
        const writer = harness({ agents: { writer: brain(scripted([answer('child answer'), answer('read it')])) }, presets: false });
        const caller = writer.createThread('writer', { label: 'Caller' });
        const child = writer.createThread('writer', { label: 'Child', ownerThreadId: caller.id });

        // The child runs, so it has a roster row, an invocation row and a transcript.
        await writer.sendThreadInput(child.id, 'work please');

        const invocationId = writer.thread(child.id)?.invocationId as string;

        expect(invocationId).toBeTypeOf('string');
        expect(writer.runtime.threadList(caller.id).actOn).toContain(child.id);

        const receipt = writer.deleteThread(child.id);

        // The mark, and the wall-clock stamp of the transition.
        const row = (writer.snapshot().threads ?? []).find(
            (thread: { id: string }) => thread.id === child.id
        ) as Record<string, any>;

        expect(row.inactive).toBe(true);
        expect(row.inactiveAt).toBeTypeOf('number');
        expect(receipt.deleted).toBe(child.id);

        // GONE from the session tooling: the roster, the writable set, the handle lookup.
        expect(writer.thread(child.id)).toBeUndefined();
        expect(writer.threads().map((thread: HarnessThreadRecord) => thread.id)).not.toContain(child.id);

        const roster = writer.runtime.threadList(caller.id);

        expect(roster.threads.map((thread: HarnessThreadRecord) => thread.id)).not.toContain(child.id);
        expect(roster.actOn).not.toContain(child.id);

        // And `agentManage` no longer lists its archived result.
        const manage = (await writer.executeTool('agentManage', {})) as {
            agents: { name: string; results: { invocationId: string }[] }[];
        };

        expect(
            manage.agents
                .find((entry) => entry.name === 'writer')
                ?.results.map((result) => result.invocationId)
        ).not.toContain(invocationId);
    });

    it('AC6.2 an agent-facing threadRead refuses the released transcript while a host read still resolves it', async () => {
        // TWO brains, because a scripted transport is per-AGENT: `worker` owns the conversation
        // that gets released, `writer` owns the caller that asks for its transcript.
        const writer = harness({
            agents: {
                writer: brain(
                    scripted(
                        [
                            callTool('t1', 'threadRead', { thread: 'thread-2' }),
                            answer('cannot read it')
                        ]
                    )
                ),
                worker: brain(scripted([answer('bytes worth keeping')]))
            },
            presets: false
        });

        const caller = writer.createThread('writer', { label: 'Caller' });
        const retired = writer.createThread('worker', { label: 'Retired' });

        await writer.sendThreadInput(retired.id, 'say it once');

        writer.deleteThread(retired.id);

        // The model asks through a live conversation, so the read is refused with the soft-delete
        // sentence rather than answering with bytes that look live.
        await writer.sendThreadInput(caller.id, 'read the released thread');

        const [refusal] = resultsForCall(writer.threadMessages(caller.id), 't1');

        expect(String(refusal?.content)).toContain('is inactive (deleted)');
        expect(String(refusal?.content)).toContain('A host can still read it by id');

        // The readability half of a soft delete is the HOST seam the refusal promises: the
        // conversation is off the roster, yet its bytes still resolve by id.
        expect(writer.thread(retired.id)).toBeUndefined();
        expect(
            (writer.threadMessages(retired.id) as HarnessMessage[]).map((message) => ({
                role: message.role,
                content: String(message.content)
            }))
        ).toEqual([
            { role: 'user', content: 'say it once' },
            { role: 'assistant', content: 'bytes worth keeping' }
        ]);
    });

    it('AC6.3 the persisted shards still carry the row, inactive, with its messages intact — the shell-visible proof', async () => {
        const root = tempRoot('it19-retention');
        const persistence = new HarnessPersistence(root);
        const store = createStore([answeringPreset()], persistence);
        const session = await store.create('probe');

        const submitted = await store.enqueue(session.id, 'a conversation worth retaining');
        await submitted.settled;
        await store.waitForIdle(session.id);

        const threadId = 'thread-1';
        const transcriptBefore = (
            store.get(session.id).threads ?? []
        ).find((thread: { id: string }) => thread.id === threadId);

        expect(transcriptBefore).toBeDefined();

        await store.deleteThread(session.id, threadId);
        await store.waitForIdle(session.id);

        // The roster the SERVER reports no longer lists it — the tooling's discovery, the same
        // exclusion AC6.1 pins in-process.
        expect((store.get(session.id).threads ?? []).map((thread: { id: string }) => thread.id)).toEqual(
            []
        );

        // Read the document the way a shell user would: `fs`, a path, and the bytes.
        const document = readDatabase(root);
        const row = (document.sessions[0].core.threads ?? []).find(
            (thread: { id: string }) => thread.id === threadId
        ) as Record<string, any>;

        expect(row.inactive).toBe(true);
        expect(row.inactiveAt).toBeTypeOf('number');

        // The transcript bytes survived the delete — this is the assertion the soft delete exists
        // for, and it is the only place the retention promise is checked where a `shell` can see.
        // The leading `system` entry is the preset's instruction seed, which is part of the
        // conversation the provider was shown, so "intact" includes it.
        expect(row.messages.map((message: { role: string }) => message.role)).toEqual([
            'system',
            'user',
            'assistant'
        ]);
        expect(String(row.messages[0].content)).toBe('sys');
        expect(String(row.messages[1].content)).toBe('a conversation worth retaining');
        expect(String(row.messages[2].content)).toBe('scripted answer');

        // A restart after the delete still sees the retained conversation: the DOCUMENT, not just
        // the live harness, is what a shell user reads. (`HarnessPersistence.load()` re-reads the
        // same bytes from disk, so this is the same proof the `fs` read above makes.)
        const reloaded = new HarnessPersistence(root).load();
        const reloadedRow = (reloaded?.sessions[0].core.threads ?? []).find(
            (thread: { id: string }) => thread.id === threadId
        ) as Record<string, any>;

        expect(
            reloadedRow.messages.map((message: { role: string; content: string }) => ({
                role: message.role,
                content: String(message.content)
            }))
        ).toEqual([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'a conversation worth retaining' },
            { role: 'assistant', content: 'scripted answer' }
        ]);

        // THE PERMANENT DELETION, for contrast: only the SESSION going removes the rows, and it
        // removes them from the document as well — the byte-level difference between a mark and a purge.
        expect(await store.remove(session.id)).toBe(true);
        expect(store.list().map((entry: { id: string }) => entry.id)).not.toContain(session.id);
        expect(readDatabase(root).sessions).toEqual([]);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('AC6.4 a host send is the one door that revives an inactive conversation, and it clears the mark', async () => {
        // ../types/index.ts:3040 — reactivation is a HOST act with exactly one door; the
        // agent-facing doors refuse the same target (AC4.6). This is the half that proves the mark
        // is a MARK: the conversation is not gone, it is undiscoverable until a host addresses it.
        const writer = harness({
            agents: { writer: brain(scripted([answer('first answer'), answer('second answer')])) },
            presets: false
        });
        const thread = writer.createThread('writer', { label: 'Released' });

        await writer.sendThreadInput(thread.id, 'say it once');
        writer.deleteThread(thread.id);

        const released = (writer.snapshot().threads ?? []).find(
            (entry: { id: string }) => entry.id === thread.id
        ) as Record<string, any>;

        expect({
            inactive: released.inactive,
            hasStamp: typeof released.inactiveAt === 'number'
        }).toEqual({ inactive: true, hasStamp: true });

        // The host turn CONTINUES the retained bytes rather than opening a fresh conversation.
        const revived = await writer.sendThreadInput(thread.id, 'say it again');

        expect(revived.content).toBe('second answer');
        expect(
            (writer.threadMessages(thread.id) as HarnessMessage[]).map((message) => String(message.content))
        ).toEqual(['say it once', 'first answer', 'say it again', 'second answer']);

        // The mark is off the row, and the conversation is discoverable by the session tooling again.
        const after = (writer.snapshot().threads ?? []).find(
            (entry: { id: string }) => entry.id === thread.id
        ) as Record<string, any>;

        expect(after.inactive).toBeUndefined();
        expect(after.inactiveAt).toBeUndefined();
        expect(writer.thread(thread.id)?.status).toBe('idle');
    });
});

// ===========================================================================
// AC7 — repair honesty for the unanswered call a retained tail ends with
// ===========================================================================

describe('AC7 — the repaired transcript says what happened, once, and is idempotent', () => {
    // A thread-bound run that commits an assistant turn asking for a call that never answers,
    // then is stopped: the tail is RETAINED (AC1) and the dangling call must be repaired.
    const unansweredCall = async () => {
        let releaseHang!: () => void;
        const hang = new Promise<string>((resolve) => {
            releaseHang = resolve;
        });

        const hangTool = tool({
            description: 'Never answers.',
            tags: ['test'],
            visibility: 'core',
            execute: () => hang
        });

        const writer = harness({
            agents: {
                writer: brain(scripted([sayThenCall('asking for it', 'tc1', 'hang', {}), answer('carried on')]))
            },
            tools: { hang: hangTool },
            presets: false
        });

        const thread = writer.createThread('writer', { label: 'Repaired' });
        const running = probe(writer.sendThreadInput(thread.id, 'go'));

        await waitUntil(
            () =>
                writer
                    .threadMessages(thread.id)
                    .some((message: HarnessMessage) => String(message.content) === 'asking for it'),
            'the committed assistant turn is in the transcript'
        );

        writer.stopThread(thread.id, 'operator stop');
        await waitUntil(() => running.status === 'rejected', 'the stopped run rejects');

        releaseHang();

        return { writer, thread, invocationId: writer.thread(thread.id)?.invocationId };
    };

    it('AC7.1 exactly one synthesized tool result for the unanswered call, and it names cancellation — never a restart', async () => {
        const scene = await unansweredCall();
        const { writer, thread } = scene;

        const messages = writer.threadMessages(thread.id);
        const results = resultsForCall(messages, 'tc1');

        // ONE, not zero (the destroyed outcome) and not two (a provider-rejected transcript).
        expect(results.length).toBe(1);

        const [result] = results;

        expect(result?.role).toBe('tool');
        expect(result?.toolCallId).toBe('tc1');
        expect(String(result?.content)).toEqual(expect.stringContaining('cancelled or interrupted'));

        // The other producer's wording belongs to a SERVER CRASH repair and claims the call was
        // never executed; this run was cancelled inside a live session, so that sentence would be
        // a different claim about a different event.
        expect(String(result?.content)).not.toContain('server restarted');

        // The repaired shape is replay-safe: every tool call in the transcript has its result.
        expect(findInterruptedToolCalls(messages as HarnessMessage[], 0)).toEqual([]);
    });

    it('AC7.2 a second repair pass over the repaired transcript changes nothing', async () => {
        const scene = await unansweredCall();
        const { writer, thread } = scene;

        const messages = writer.threadMessages(thread.id) as HarnessMessage[];
        const before = JSON.parse(JSON.stringify(messages)) as HarnessMessage[];

        // The real seam, run again over the real retained bytes: nothing dangling, nothing written.
        expect(findInterruptedToolCalls(messages, 0)).toEqual([]);
        expect(repairInterruptedToolCalls(messages, 0, () => ({ role: 'tool' }))).toEqual([]);
        expect(JSON.parse(JSON.stringify(messages))).toEqual(before);

        // And the LIVE transcript still holds one placeholder after the conversation continues —
        // a revive does not re-repair the same call.
        await writer.sendThreadInput(thread.id, 'carry on');

        expect(resultsForCall(writer.threadMessages(thread.id), 'tc1').length).toBe(1);
    });
});

// ===========================================================================
// On-disk fixtures (the ./server/threads.test.ts pattern, pointed at repo-root Temp/)
// ===========================================================================

const PRESET_SETTINGS = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'super-secret-key',
    model: 'scripted/test'
};

// One scripted preset that answers every prompt in one turn: the store fixture AC6.3 needs, with
// no gate, so the only timing in that test is the store's own durable-write boundary.
const answeringPreset = (): HarnessPreset => ({
    name: 'probe',
    title: 'probe',
    description: 'probe scripted preset',
    requiresEndpoint: false,
    entry: 'probe',
    agents: ['probe'],
    tools: [],
    builtin: true,
    editable: true,
    create: (settings) =>
        harness({
            agents: {
                probe: agent({
                    model: settings.model,
                    instruction: 'sys',
                    retry: false,
                    stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
                        yield { type: 'text', delta: 'scripted answer' };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            entry: 'probe',
            presets: false
        })
});

const createStore = (presets: HarnessPreset[], persistence?: HarnessPersistence): SessionStore =>
    new SessionStore(
        PRESET_SETTINGS,
        createHarnessRegistry(presets),
        undefined,
        // The 3rd argument is the descriptor factory; persistence rides in `options`.
        persistence === undefined ? {} : { persistence }
    );

// Repo-root `Temp/` (root AGENTS.md): a crashed run leaves an inspectable document instead of a
// directory in the OS temp nobody can find. Same resolution ./server/thread-stop-reference.test.ts:220 uses.
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMP_ROOT = path.join(path.resolve(PACKAGE_ROOT, '../../..'), 'Temp');
const roots: string[] = [];

const tempRoot = (label: string): string => {
    fs.mkdirSync(TEMP_ROOT, { recursive: true });

    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-it19-retention-${label}-`));
    roots.push(root);

    return root;
};

// The exact bytes a `cat` would show. v2 splits one session across shards — `sessions/<id>/
// session.json` (the record, whose `core.threads[]` rows carry NO messages) and
// `sessions/<id>/threads/<threadId>.json` (the transcript) — so the shared reader reassembles
// them into the one-document view these pins were written against; the messages it puts back
// are read from the shard files, which is what makes "the bytes are still on disk" a real claim.
const readDatabase = readPersistedDocument;

// Explicit primary/subagent configuration and bounded delegation (R4).
//
// Contract pinned here:
//   - `primary` selects the entry agent; without it the first `agents` key wins;
//   - `subagents` is an allowlist, defaulting to every agent except the primary;
//   - the `delegate` tool is core but declared ONLY to the primary, so a subagent
//     never sees it (and a guessed call is rejected);
//   - delegation is one level deep: only a top-level primary run may delegate, and
//     re-entering a running agent is refused (ctx.run cycles included);
//   - each agent keeps its own seeded instructions and transcript; only the answer
//     crosses back;
//   - a delegated child's result is the last substantive tool-free answer of THAT
//     run when its final normal turn is whitespace-only (the literal transcript
//     and `done` stay unchanged); a truly blank child stays blank;
//   - primary/subagent names are validated at construction, so a typo fails fast.
//
// Policy change 2026-11-09 (docs/tasks/2026-11-09-thread-timeout-policy.md): the
// wall-clock DEFAULT on a delegated child is gone — an omitted `timeoutMs` arms no
// timer at all, `timeoutMs` is an optional caller-set bound, and the model schema's
// 1..3600000 range bounds a model argument only (the unvalidated host path is not
// clamped). See `delegation time limits (policy 2026-11-09)`,
// `delegate timeoutMs bounds (policy 2026-11-09)`,
// `pending delegation placeholder (delegate-stress T1.3/T1.4)`,
// `liveness wake covers a delegated child (policy 2026-11-09 T8)` and
// `harness source shape (policy 2026-11-09 T5.5)` at the end of this file.
//
// Finding I5 adds the COUNT bound a caller sets on ONE delegation: `maxTurns` caps the
// child's model turns and can only lower the harness-wide `maxIterations`. See
// `per-delegation turn cap (I5)`, and note the T5.5 block now also pins that BOTH
// opt-in clocks (this file's `timeoutMs` and `threadFork`'s) arm through the single
// `armWallClock` helper in `src/harness.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agent, harness, tool } from '@underload/harness';
import type {
    Agent,
    HarnessEvent,
    HarnessMessage,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from '@underload/harness';

// Canonical transcript entries now carry a minted `messageId` (context T1,
// src/core/message-id.ts): a stable ADDRESS for a turn, i.e. an identity field like a
// timestamp rather than part of the content these assertions pin. Stripping it DEEPLY
// keeps every expected value here exactly what it was, and the id itself is pinned
// exactly where it is the subject: src/harness.inclusion.test.ts (minting, `entries`,
// addressing by id), src/harness.snapshot.test.ts (persistence and restore-without-ids)
// and src/harness.fork.test.ts (ids COPIED across a fork).
const withoutIds = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutIds);

    if (typeof value === 'object' && value !== null) {
        const entries: [string, unknown][] = [];

        for (const [key, child] of Object.entries(value)) {
            // The only key dropped is the id; `undefined`-valued keys stay, so a
            // `toStrictEqual` comparison keeps its strictness about them.
            if (key === 'messageId') continue;
            entries.push([key, withoutIds(child)]);
        }

        return Object.fromEntries(entries);
    }

    return value;
};

const scripted = (turns: HarnessStreamEvent[][], seen?: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;
    return async function* stream(request) {
        seen?.push(request);
        const frames = turns[index] ?? turns[turns.length - 1];
        index++;
        for (const frame of frames) {
            yield frame;
        }
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const callTool = (id: string, name: string, args: string): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

const declaredNames = (request: HarnessStreamRequest | undefined): string[] =>
    (request?.tools ?? []).map((declaration) => declaration.name);

const brain = (stream: HarnessStream, extra: Record<string, unknown> = {}): Agent =>
    agent({ model: 'merge/ds4-flash', stream, ...extra });

const content = (message: unknown): string => (message as { content: string }).content;

// T28: the delegate result is no longer `{ agent, content }`. It carries the same
// identity agentManage/agentResult report plus a paged answer, so a test that pins the
// exact JSON string would pin the whole envelope. These helpers assert the two fields
// the contract is ABOUT (which agent answered, and what it said) and leave the identity
// fields to the dedicated envelope test below.
const delegationOf = (message: unknown): Record<string, any> =>
    JSON.parse(content(message)) as Record<string, any>;

const answerOf = (message: unknown): { agent: string; content: string } => {
    const parsed = delegationOf(message);
    return { agent: parsed.agent, content: parsed.content };
};

// ---------------------------------------------------------------------------
// Fake-clock helpers (the 2026-11-09 time-policy tests)
// ---------------------------------------------------------------------------
//
// Every assertion about wall-clock time in this file moves the clock on purpose.
// `harness.background.test.ts` / `harness.sync-async.test.ts` established the
// pattern (and `src/harness.ts`'s only turn-bounding timer is asserted against it),
// so a test that needs "five minutes later" never sleeps for it.
//
// `flush` drains the harness's promise chain WITHOUT moving the clock — several
// zero-advance passes are needed because a launch → re-request → pause chain spans
// more microtasks than one `await` can settle.
const flush = async (): Promise<void> => {
    for (let pass = 0; pass < 32; pass += 1) {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
    }
};

// Move the clock by an exact amount, then let the resulting work settle.
const advance = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
};

// Real-time settle (20 ms): the same helper the cancel describe defines locally at
// :1138. The 0019/0020 cases below need real timers because cancellation and the
// re-drive cross actor boundaries, and a fake clock cannot interleave them honestly.
const realSettle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

const deferred = <T>() => {
    let settle!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        settle = resolve;
    });
    return { promise, resolve: settle };
};

// Attach handlers immediately so a rejection never becomes unhandled, and expose
// the settled state so a test can prove a child is STILL RUNNING at an instant.
const probe = <T>(promise: Promise<T>): { status: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } => {
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

// The liveness wakes the runtime emitted, for a given agent.
const wakeupsFor = (events: readonly HarnessEvent[], agentName: string) =>
    events
        .filter((event): event is Extract<HarnessEvent, { type: 'wakeup' }> => event.type === 'wakeup')
        .filter((event) => event.agent === agentName);

// A tool whose execution parks until the test releases it. `mode: 'async'` is
// deliberate where a test needs the CALLING run to keep taking turns while it is
// parked (a sync call holds that message's batch gate).
const parkedTool = (name: string, gate: Promise<string>, mode?: 'async') =>
    tool({
        description: `Park ${name} until released.`,
        tags: ['test'],
        visibility: 'core',
        ...(mode === undefined ? {} : { mode }),
        execute: () => gate
    });

// ---------------------------------------------------------------------------
// issue 0020 (AC1) fixtures — a child that STREAMS and then parks
// ---------------------------------------------------------------------------
//
// `scripted([...answer(t)])` yields the text and then `done` in the same tick, so
// the assistant message is committed before the run can be interrupted. The state
// this issue is about — "interrupted with an answer in hand" where the answer was
// never committed — needs a stream that emits its text and then never finishes.
// `marker` lets a test observe the exact instant the child is parked mid-request:
// the delta has left the transport, the harness has buffered it, and the model
// request is still open.
const parkedBeforeFirstDelta = (gate: Promise<unknown>): HarnessStream =>
    async function* stream() {
        await gate;
        yield { type: 'text', delta: 'never reached' };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };

const streamedThenParked = (
    text: string,
    gate: Promise<unknown>,
    marker?: { resolve: () => void }
): HarnessStream =>
    async function* stream() {
        yield { type: 'text', delta: text };
        marker?.resolve();
        await gate;
        // Only reached if the test releases the gate; the cancel tests never do.
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };

// Counts the transcript entries that account for a child's outcome. `marker` is a
// phrase only the child's OWN answer contains, so it appears once per account and
// never as a side effect of surrounding runtime text. A delegation is "reported"
// when this is exactly 1 — 0 means the outcome was discarded, 2 means the next turn
// re-reported an outcome the transcript already carried.
const accountsFor = (messages: readonly unknown[], marker: string): number =>
    messages.filter((message) => JSON.stringify(message).includes(marker)).length;

// ---------------------------------------------------------------------------
// issues 0019 + 0020 (docs/issues/*.md) — every terminal child is reported, and a
// cancelled child reports what it actually said
// ---------------------------------------------------------------------------
//
// 0019: a `delegate` call can be discarded with no transcript account. The four
// exits are: the parent terminates after launching the call, the launching request
// is discarded, the call is parked when the parent's terminal lands, and the queue
// abandons the carrier scope. What must hold across ALL of them is one invariant:
// a conversation that has drained carries EXACTLY ONE account of a settled child,
// and that account agrees with what the thread ledger says.
//
// 0020 (AC1): a child cancelled or turn-exhausted mid-sentence must report the text
// it streamed. `HarnessAgentRunResult.partialContent` is the contract field
// (src/types/index.ts:2254); until this issue it was only ever set by the
// maxTurns-exhaustion throw, so an interrupted child that had streamed prose and
// committed nothing reported nothing.
// The released read surfaces these tests use. `threads()` is how a test OBSERVES a
// child's invocation id (the runtime's rule: ids are never invented), and
// `agentResult` is the durable terminal record for that id.
const childOf = (
    instance: any,
    agentName = 'researcher'
): { invocationId: string; agent: string; status: string } => {
    const threads = instance.threads() as {
        invocationId?: string;
        agent: string;
        status: string;
    }[];
    const child = threads.find((entry) => entry.agent === agentName);

    if (child?.invocationId === undefined) throw new Error(`no thread for ${agentName}`);

    return { ...child, invocationId: child.invocationId };
};

const recordOf = async (instance: any, invocationId: string): Promise<Record<string, any>> =>
    (await instance.executeTool('agentResult', { agent: 'researcher', invocationId })) as Record<string, any>;

// The `delegate` envelope the parent's transcript carries for a given call id.
const envelopeOfCall = (messages: readonly unknown[], callId: string): Record<string, any> => {
    const message = messages.find(
        (entry) =>
            (entry as { role?: string; toolCallId?: string }).role === 'tool' &&
            (entry as { toolCallId?: string }).toolCallId === callId
    );

    if (message === undefined) throw new Error(`no tool result for ${callId}`);

    return JSON.parse((message as { content: string }).content) as Record<string, any>;
};

describe('a settled delegation is never silently stranded (issue 0019)', () => {
    // A structurally valid transcript: every tool result answers a call the
    // transcript actually contains. An orphan result is how "we had to report it
    // somewhere" silently becomes "the provider rejected the next request".
    const orphanToolResults = (messages: readonly unknown[]): string[] => {
        const called = new Set<string>();

        for (const message of messages) {
            const entry = message as { role?: string; toolCalls?: { id: string }[] };

            if (entry.role === 'assistant') {
                for (const call of entry.toolCalls ?? []) called.add(call.id);
            }
        }

        return messages
            .filter((message) => (message as { role?: string }).role === 'tool')
            .map((message) => (message as { toolCallId: string }).toolCallId)
            .filter((id) => !called.has(id));
    };

    it('accounts for a child that settled after its parent was cut off by its turn budget', async () => {
        const gate = deferred<void>();
        const researcher = brain(streamedThenParked('late: the module is fine', gate.promise));
        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"review src/a.ts"}'),
                answer('noted')
            ])
        );

        // One model turn: the delegate call is launched and the budget is gone, so the
        // run terminates with its tool call parked (issue 0019's first exit, through
        // the turn-budget door).
        const writer = harness({
            agents: { writer: writerAgent, researcher },
            presets: false,
            maxIterations: 1
        });

        await expect(writer('go')).rejects.toThrow(
            /requested tools on its single model turn without answering/
        );

        // An exhausted run ROLLS BACK its turns, so the transcript does not even hold
        // the `delegate` call any more: an account CANNOT be a tool result for `c1`,
        // and the runtime must not invent one there.
        expect(withoutIds(writerAgent.messages)).toEqual([]);

        gate.resolve();
        await realSettle();

        // The child is terminal — cancelled, because terminating the parent released
        // its context — and its record says so. What the conversation says is the
        // finding: it must carry an account of that outcome.
        const child = childOf(writer);
        const record = await recordOf(writer, child.invocationId);
        expect(record.status).toBe('cancelled');

        await writer('go2');

        // EXACTLY ONE account of the child's outcome in the parent's conversation, and
        // it must be addressable by a provider: no tool result for a call the
        // transcript never carried.
        expect(accountsFor(writerAgent.messages, 'late: the module is fine')).toBe(1);
        expect(orphanToolResults(writerAgent.messages)).toEqual([]);

        // A third turn does not re-report what the transcript already said.
        await writer('go3');
        expect(accountsFor(writerAgent.messages, 'late: the module is fine')).toBe(1);
        expect(orphanToolResults(writerAgent.messages)).toEqual([]);

        // AC2's drain invariant, stated over BOTH channels: the queue is empty (a settled
        // record is never reported twice, and nothing is left queued behind the answer), and
        // the LEDGER half still holds the same outcome — the account is not the only copy, so
        // a caller that wants the record can still read it by id after the register has
        // finished with it.
        const drained = await recordOf(writer, child.invocationId);

        expect(drained).toMatchObject({
            invocationId: child.invocationId,
            status: 'cancelled',
            partialContent: 'late: the module is fine'
        });
    });

    it('accounts for a child that settled after its parent was aborted with the call in flight', async () => {
        const gate = deferred<void>();
        const controller = new AbortController();
        const researcher = brain(streamedThenParked('late: the module is fine', gate.promise));
        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"review src/a.ts"}'),
                answer('noted')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });

        // The parent parks INSIDE the `delegate` tool; aborting lands its terminal
        // while the child's launch is in flight and cancels the child.
        const running = writer('go', { signal: controller.signal });
        await realSettle();
        controller.abort();

        await expect(running).rejects.toThrow();
        gate.resolve();
        await realSettle();

        const child = childOf(writer);
        const record = await recordOf(writer, child.invocationId);
        expect(record.status).toBe('cancelled');

        await writer('go2');

        expect(accountsFor(writerAgent.messages, 'late: the module is fine')).toBe(1);
        expect(orphanToolResults(writerAgent.messages)).toEqual([]);

        // The abort door does not report twice either. `abandonScope` cleared the task's
        // `_notify`, so the child's late settlement is data on a dead task: the register saw
        // the debt once (at the abandonment), paid it on `go2`, and has nothing left to pay.
        await writer('go3');
        expect(accountsFor(writerAgent.messages, 'late: the module is fine')).toBe(1);
        expect(orphanToolResults(writerAgent.messages)).toEqual([]);
    });

    it('keeps the ONE account a still-open conversation already carries (no duplicate on the next turn)', async () => {
        // The shape the runtime already handles: the child settles while the parent's
        // conversation is still open. This pins that a re-drive does not re-report on
        // the next turn what the transcript has already said.
        const gate = deferred<void>();
        const researcher = brain(streamedThenParked('the module is fine', gate.promise));
        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"review src/a.ts"}'),
                answer('noted')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        const running = writer('go');
        await realSettle();
        gate.resolve();

        await running;
        expect(accountsFor(writerAgent.messages, 'the module is fine')).toBe(1);

        await writer('go2');
        expect(accountsFor(writerAgent.messages, 'the module is fine')).toBe(1);
        expect(orphanToolResults(writerAgent.messages)).toEqual([]);
    });

    it('drops an UNPAID account when a restore replaces the runtime state that owed it', async () => {
        // The register is RUNTIME state, exactly like the mailbox FIFOs beside it: `snapshot()`
        // and `restore()` model the PERSISTED contract, and AC5 accepts the window in which the
        // process dies with an unpaid debt. A restore is that window made explicit — the debt is
        // owned by a conversation the incoming document may not even contain — so `restore()`
        // clears the register instead of replaying an account into a session that did not earn
        // it. The counterfactual is the first test above: the SAME exhausted run, with no
        // restore in the way, prints exactly one account on its next turn. What survives here is
        // the durable half — the ledger still answers the id.
        const gate = deferred<void>();
        const researcher = brain(streamedThenParked('late: the module is fine', gate.promise));
        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"review src/a.ts"}'),
                answer('noted')
            ])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher },
            presets: false,
            maxIterations: 1
        });

        await expect(writer('go')).rejects.toThrow(
            /requested tools on its single model turn without answering/
        );

        gate.resolve();
        await realSettle();

        const child = childOf(writer);
        const snapshot = writer.snapshot();

        writer.restore(snapshot);

        // The debt was runtime state, so it is gone with the state it belonged to.
        await writer('go2');
        expect(accountsFor(writerAgent.messages, 'late: the module is fine')).toBe(0);
        expect(orphanToolResults(writerAgent.messages)).toEqual([]);

        // The durable half of the same window: the terminal record travelled with the snapshot,
        // so the id the account would have named is still readable after the reload.
        expect(await recordOf(writer, child.invocationId)).toMatchObject({
            status: 'cancelled',
            partialContent: 'late: the module is fine'
        });
    });
});

describe('a cancelled child reports the answer it was streaming (issue 0020 AC1)', () => {
    // A child streams an answer, parks INSIDE the request (nothing is committed), and
    // is cancelled while its parent is parked on the `delegate` call. `abort` chooses
    // how the parent is cut off; it returns once the child is terminal, so every
    // assertion below runs against a settled ledger with no wall-clock dependence.
    const cancelledMidSentence = async (options: {
        turns: (yield: (event: HarnessStreamEvent) => void) => Promise<void>;
        abort: (writer: any, controller: AbortController, running: Promise<unknown>) => Promise<void>;
        stream: HarnessStream;
    }) => {
        const researcher = brain(options.stream);
        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"review src/a.ts"}'),
                answer('noted')
            ])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher },
            tools: options.turns === undefined ? {} : {
                read: tool({
                    description: 'Read.',
                    tags: ['files'],
                    visibility: 'core',
                    execute: () => 'a long tool body full of facts'
                })
            },
            presets: false
        });

        const controller = new AbortController();
        const running = writer('go', { signal: controller.signal });
        await realSettle();

        await options.abort(writer, controller, running);

        return { writer, writerAgent };
    };

    it('reports the in-flight streamed text as partialContent when the child is cancelled', async () => {
        const childGate = deferred<void>();
        const researcher = brain(streamedThenParked('nine seconds of prose', childGate.promise));
        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"review src/a.ts"}'),
                answer('noted')
            ])
        );

        const controller = new AbortController();
        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });

        const running = writer('go', { signal: controller.signal });
        await realSettle();

        // The parent terminates while the child is mid-request; releasing the context
        // cancels the child, and the gate release is what lets its parked transport
        // unwind so the cancellation can be recorded.
        controller.abort();
        await expect(running).rejects.toThrow();
        childGate.resolve();
        await realSettle();

        const child = childOf(writer);
        const record = await recordOf(writer, child.invocationId);

        // AC1: the prose it had streamed is reported, on the released door, with the
        // identity fields the cancellation contract already carries.
        expect(record.status).toBe('cancelled');
        expect(record.error).toBe('This operation was aborted');
        expect(record.content).toBe('nine seconds of prose');
        expect(record.partialContent).toBe('nine seconds of prose');
        expect(record.contentLength).toBe('nine seconds of prose'.length);
    });

    it('reports only the prose of the request that was in flight, not earlier transcript text', async () => {
        // The leak guard. A child that answered one turn, took a tool result, and is
        // then cut off mid-sentence reports ONLY the in-flight sentence: tool OUTPUT,
        // the child's instructions and the injected delegation input all live in that
        // same conversation, and an unbounded scan of it would pull them in.
        const childGate = deferred<void>();
        let researcherTurn = 0;

        const researcher = brain(async function* stream() {
            researcherTurn += 1;

            if (researcherTurn === 1) {
                yield { type: 'text', delta: 'earlier paragraph. ' };
                yield {
                    type: 'done',
                    stopReason: 'tool_calls',
                    toolCalls: [{ id: 'r1', name: 'read', arguments: '{"path":"src/a.ts"}' }]
                };
                return;
            }

            yield { type: 'text', delta: 'mid-sentence' };
            await childGate.promise;
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        });

        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"review src/a.ts"}'),
                answer('noted')
            ])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher },
            tools: {
                read: tool({
                    description: 'Read.',
                    tags: ['files'],
                    visibility: 'core',
                    execute: () => 'a long tool body full of facts'
                })
            },
            presets: false
        });

        const controller = new AbortController();
        const running = writer('go', { signal: controller.signal });
        await realSettle();
        controller.abort();
        await expect(running).rejects.toThrow();
        childGate.resolve();
        await realSettle();

        // The parent's run was aborted, so its own turn is rolled back and the
        // envelope may not survive in the transcript — the durable record is the
        // surface AC1 names, and it must carry the in-flight sentence alone.
        const child = childOf(writer);
        const record = await recordOf(writer, child.invocationId);
        expect(record.status).toBe('cancelled');
        expect(record.partialContent).toBe('mid-sentence');
        expect(record.content).toBe('mid-sentence');
    });

    it('reports the in-flight partial through the model-facing delegation timeout as well', async () => {
        // The other cancellation door the finding names: `timeoutMs`. The cut lands
        // while the transport is still parked, so this also pins that the parent's
        // abandoned-child record does not lose the partial the child was streaming.
        const childGate = deferred<void>();
        const researcher = brain(streamedThenParked('nine seconds of prose', childGate.promise));
        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    '{"agent":"researcher","input":"review src/a.ts","timeoutMs":30}'
                ),
                answer('noted')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        const running = writer('go');

        // Real timers: the bound is a wall-clock one, and the test moves PAST it before
        // releasing the transport, so the cancellation is unambiguously first.
        await new Promise((resolve) => setTimeout(resolve, 80));
        childGate.resolve();
        await running;

        const envelope = envelopeOfCall(writerAgent.messages, 'c1');
        expect(envelope.status).toBe('cancelled');
        expect(envelope.error).toBe(
            'Delegation to "researcher" exceeded its 30ms timeout and was stopped.'
        );
        expect(envelope.content).toBe('nine seconds of prose');
        expect(envelope.partialContent).toBe('nine seconds of prose');

        const record = await recordOf(writer, envelope.invocationId);
        expect(record.status).toBe('cancelled');
        expect(record.partialContent).toBe('nine seconds of prose');
        expect(record.content).toBe('nine seconds of prose');
    });

    it('reports no partialContent for a child cancelled before it streamed anything', async () => {
        const childGate = deferred<void>();
        // The child is mid-REQUEST with nothing streamed: the in-flight buffer is empty
        // and the transcript holds only the delegation input.
        const researcher = brain(parkedBeforeFirstDelta(childGate.promise));
        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"review src/a.ts"}'),
                answer('noted')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        const controller = new AbortController();
        const running = writer('go', { signal: controller.signal });
        // Let the child's request open, then cut the parent: the child is cancelled
        // inside its first request, having streamed nothing.
        await realSettle();
        controller.abort();
        await expect(running).rejects.toThrow();
        childGate.resolve();
        await realSettle();

        // Absent, not empty: the child never said anything. `min: 1` in the snapshot
        // reader (src/core/snapshot.ts) is what makes that distinction durable across a
        // restart, and a present value always means text the child really produced.
        const child = childOf(writer);
        const record = await recordOf(writer, child.invocationId);
        expect(record.status).toBe('cancelled');
        expect('partialContent' in record).toBe(false);
        expect(record.content).toBe('');
    });
});

describe('primary and subagents', () => {
    it('selects the primary explicitly and defaults the allowlist to the rest', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('w')])), researcher: brain(scripted([answer('r')])) },
            primary: 'researcher',
            presets: false
        });

        expect(writer.name).toBe('researcher');
        expect(writer.agent).toBe(writer.agents.researcher);
        expect(Object.keys(writer.subagents)).toEqual(['writer']);
        expect(writer.tools.delegate).toBeDefined();
    });

    it('keeps the first agents key as primary when none is named', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('w')])), researcher: brain(scripted([answer('r')])) },
            presets: false
        });

        expect(writer.name).toBe('writer');
        expect(Object.keys(writer.subagents)).toEqual(['researcher']);
    });

    it('creates no delegation surface when the allowlist is empty', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('w')])), researcher: brain(scripted([answer('r')])) },
            subagents: [],
            presets: false
        });

        expect(writer.subagents).toEqual({});
        expect(writer.tools.delegate).toBeUndefined();
    });

    it('uses an explicit allowlist and exposes it on the tool schema', () => {
        const writer = harness({
            agents: {
                writer: brain(scripted([answer('w')])),
                researcher: brain(scripted([answer('r')])),
                editor: brain(scripted([answer('e')]))
            },
            subagents: ['researcher'],
            presets: false
        });

        expect(Object.keys(writer.subagents)).toEqual(['researcher']);
        expect(
            (writer.tools.delegate.parameters as Record<string, any>).properties.agent.enum
        ).toEqual(['researcher']);
    });

    it('validates the primary and subagent names at construction', () => {
        const agents = { writer: brain(scripted([answer('w')])), researcher: brain(scripted([answer('r')])) };

        expect(() => harness({ agents, primary: 'ghost' })).toThrow(
            'Primary agent "ghost" is not registered. Configured agents: writer, researcher.'
        );

        expect(() => harness({ agents, subagents: ['ghost'] })).toThrow(
            'Subagent "ghost" is not registered. Configured agents: writer, researcher.'
        );

        expect(() => harness({ agents, subagents: ['writer'] })).toThrow(
            'Subagent "writer" is the primary agent "writer"; the primary cannot delegate to itself.'
        );
    });
});

describe('delegate', () => {
    it('declares delegate to the primary only', async () => {
        const seenWriter: HarnessStreamRequest[] = [];
        const seenResearcher: HarnessStreamRequest[] = [];

        const researcher = brain(scripted([answer('facts')], seenResearcher));
        const writerAgent = brain(
            scripted(
                [
                    callTool('c1', 'delegate', '{"agent":"researcher","input":"find facts"}'),
                    answer('final')
                ],
                seenWriter
            )
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        // The primary sees the bootstrap pair plus delegate. The subagent never sees
        // the delegation control, so its declarations are exactly the pair.
        expect(declaredNames(seenWriter[0])).toEqual([
            'toolRequest',
            'tasks',
            'delegate',
        ]);
        expect(declaredNames(seenResearcher[0])).toEqual([
            'toolRequest',
            'tasks'
        ]);
    });

    it('runs the subagent under its own instructions and returns only its answer', async () => {
        const researcher = brain(scripted([answer('the facts')]), {
            instruction: 'You are a researcher. Answer briefly.'
        });

        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"find facts"}'),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        const message = await writer('go');

        expect(message.content).toBe('final');

        // Only the answer crosses back, as data.
        expect(answerOf(writerAgent.messages[2])).toEqual({
            agent: 'researcher',
            content: 'the facts'
        });

        // The subagent kept its own instruction and transcript.
        expect(researcher.instructions).toEqual(['You are a researcher. Answer briefly.']);
        expect(withoutIds(researcher.messages)).toEqual([
            { role: 'system', content: 'You are a researcher. Answer briefly.' },
            { role: 'user', content: 'find facts' },
            { role: 'assistant', content: 'the facts' }
        ]);
    });

    it('refuses an agent outside the allowlist', async () => {
        const researcher = brain(scripted([answer('r')]));
        const editor = brain(scripted([answer('e')]));
        const writerAgent = brain(
            scripted([callTool('c1', 'delegate', '{"agent":"editor","input":"edit"}'), answer('recovered')])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher, editor },
            subagents: ['researcher'],
            presets: false
        });

        await writer('go');

        expect(content(writerAgent.messages[2])).toBe(
            'Tool "delegate" received arguments that do not match its schema: $.agent must be one of: "researcher".'
        );
    });

    it('rejects a subagent that tries to delegate (guessed name)', async () => {
        const researcher = brain(
            scripted([
                callTool('r1', 'delegate', '{"agent":"researcher","input":"again"}'),
                answer('blocked')
            ])
        );

        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"go"}'),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        // The subagent's call is answered with a tool result it can read; the run
        // does not crash and delegation stays one level deep.
        expect(content(researcher.messages[2])).toBe(
            'Tool "delegate" is only available to the primary agent "writer".'
        );
        expect(answerOf(writerAgent.messages[2])).toEqual({
            agent: 'researcher',
            content: 'blocked'
        });
    });
    it('refuses to re-enter a running agent through ctx.run', async () => {
        const recurse = tool({
            description: 'Re-enter the writer.',
            tags: ['agents'],
            visibility: 'core',
            execute: ({ run }) => run!('writer', 'again')
        });

        const entry = brain(scripted([callTool('c1', 'recurse', '{}'), answer('recovered')]));
        const writer = harness({ agents: { writer: entry }, tools: { recurse }, presets: false });
        const message = await writer('go');

        expect(message.content).toBe('recovered');
        expect(content(entry.messages[2])).toBe(
            'Tool "recurse" failed: Agent "writer" is already running; it cannot be re-entered (delegation cycle).'
        );
    });

    // T2/R1: a tool-call turn's visible text is a PREAMBLE, not an answer. A blank
    // final turn must never be "repaired" with it.
    it('does not rescue text from a tool-call preamble', async () => {
        const probe = tool({
            description: 'Probe the catalogue.',
            tags: ['test'],
            visibility: 'core',
            execute: () => 'probed'
        });

        const researcher = brain(
            scripted([
                [
                    { type: 'text', delta: 'checking the catalogue' },
                    {
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [{ id: 'r1', name: 'probe', arguments: '{}' }]
                    }
                ],
                answer('\n')
            ])
        );

        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"find facts"}'),
                answer('final')
            ])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher },
            tools: { probe },
            presets: false
        });

        await writer('go');

        // The literal blank terminal turn crosses back: the preamble is not an
        // answer, so there is nothing substantive to fall back to.
        expect(answerOf(writerAgent.messages[2])).toEqual({
            agent: 'researcher',
            content: '\n'
        });
    });

    // T2/R1: no substantive text anywhere in the run => keep the exact blank result
    // rather than inventing an answer.
    it('keeps a genuinely blank answer when nothing substantive was said', async () => {
        const researcher = brain(scripted([answer('\n')]));

        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"find facts"}'),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        // The child's own transcript keeps the blank turn...
        expect(content(researcher.messages.at(-1))).toBe('\n');
        // ...and the delegate returns it verbatim.
        expect(answerOf(writerAgent.messages[2])).toEqual({
            agent: 'researcher',
            content: '\n'
        });
    });

    // R12: reset() is a session restart, so it must clear EVERY agent's
    // transcript — a subagent used to keep its conversation across a reset, which
    // leaked one session into the next. Seeded instructions stay.
    it('reset() clears every agent transcript, not just the entry agent', async () => {
        const researcher = brain(scripted([answer('facts')]), {
            instruction: 'You are a researcher.'
        });
        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"find facts"}'),
                answer('final')
            ]),
            { instruction: 'You are a writer.' }
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        // Both agents really have a conversation before the reset.
        expect(writerAgent.messages.map((message) => message.role)).toEqual([
            'system',
            'user',
            'assistant',
            'tool',
            'assistant'
        ]);
        expect(researcher.messages.map((message) => message.role)).toEqual([
            'system',
            'user',
            'assistant'
        ]);

        writer.reset();

        expect(withoutIds(writerAgent.messages)).toEqual([{ role: 'system', content: 'You are a writer.' }]);
        expect(withoutIds(researcher.messages)).toEqual([{ role: 'system', content: 'You are a researcher.' }]);
    });
});

// ---------------------------------------------------------------------------
// T28 — the delegation result contract
// ---------------------------------------------------------------------------
//
// The result used to be `{ agent, content }`: no identity, no bound, and no account
// of a child that did not finish. Each test below pins one of the three fixes.
describe('delegation result contract (T28)', () => {
    it('returns the invocation identity agentManage/agentResult report', async () => {
        const researcher = brain(scripted([answer('the facts')]));
        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"find facts"}'),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        const result = delegationOf(writerAgent.messages[2]);

        // The SAME id agentResult takes, the conversation threadSend/threadRead
        // address, the terminal status, and the measured span. Before this, a caller
        // had to call threadList and match by agent name plus sequence order, which is
        // ambiguous with two concurrent runs of one agent.
        expect(result).toMatchObject({
            agent: 'researcher',
            content: 'the facts',
            contentLength: 9,
            offset: 0,
            limit: 8000,
            truncated: false,
            status: 'completed',
            threadId: 'agent:researcher',
            invocationId: expect.any(String),
            durationMs: expect.any(Number)
        });

        // The reported id really addresses the same answer through agentResult.
        const stored = (await writer.executeTool('agentResult', {
            agent: 'researcher',
            invocationId: result.invocationId
        })) as { content: string; status: string };

        expect(stored).toMatchObject({ content: 'the facts', status: 'completed' });
    });

    it('pages a long answer instead of returning it whole', async () => {
        const long = 'x'.repeat(20_000);
        const researcher = brain(scripted([answer(long)]));
        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"write it all"}'),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        const result = delegationOf(writerAgent.messages[2]);

        // One page, an explicit continuation, and the FULL length — the 58 KB inline
        // payload is what this replaces.
        expect(result.content).toHaveLength(8000);
        expect(result.contentLength).toBe(20_000);
        expect(result.truncated).toBe(true);
        expect(result.nextOffset).toBe(8000);

        // The rest is reachable through the SAME pager agentResult uses.
        const rest = (await writer.executeTool('agentResult', {
            agent: 'researcher',
            invocationId: result.invocationId,
            offset: result.nextOffset,
            limit: 8000
        })) as { content: string; hasMore: boolean; nextOffset?: number };

        expect(rest.content).toHaveLength(8000);
        expect(rest.hasMore).toBe(true);
        expect(rest.nextOffset).toBe(16_000);
    });

    it('honours an explicit maxChars page bound', async () => {
        const researcher = brain(scripted([answer('abcdefghij')]));
        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"go","maxChars":4}'),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        expect(delegationOf(writerAgent.messages[2])).toMatchObject({
            content: 'abcd',
            contentLength: 10,
            limit: 4,
            truncated: true,
            nextOffset: 4
        });
    });

    it('gates an under-specified brief at dispatch when asked to', async () => {
        const seen: HarnessStreamRequest[] = [];
        const researcher = brain(scripted([answer('should not run')], seen));
        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    '{"agent":"researcher","input":"Fix the bug.","requireClarification":true}'
                ),
                answer('recovered')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        // The refusal is a tool result the model can act on, and the child never ran:
        // no request reached it, so nothing was mutated and no recon was spent.
        expect(content(writerAgent.messages[2])).toContain('is under-specified');
        expect(content(writerAgent.messages[2])).toContain('concrete target');
        expect(seen).toHaveLength(0);
        expect(researcher.messages).toEqual([]);
    });

    it('accepts a brief that names a target and an acceptance criterion', async () => {
        const seen: HarnessStreamRequest[] = [];
        const researcher = brain(scripted([answer('done')], seen));
        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    '{"agent":"researcher","input":"Fix the null check in src/parse.ts so the test passes.","requireClarification":true}'
                ),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        expect(seen).toHaveLength(1);
        expect(answerOf(writerAgent.messages[2])).toEqual({ agent: 'researcher', content: 'done' });
    });

    // ------------------------------------------------------------------
    // Issue 0025 (2026-11-14) — the brief gate reads SUBSTANCE, not a magic phrase.
    //
    // Three directions, each pinned separately because the old single word list failed in both
    // directions at once and the original pass only tested one of them:
    //   * an explicit output shape or COUNT is a criterion (AC1) — the brief below names a file,
    //     an operation, a shape and a count, and used to be refused;
    //   * a brief that names no target is still refused BEFORE the child runs, and the refusal
    //     still names exactly the part that is missing (AC2);
    //   * a causal or incidental word is no longer an acceptance signal (the review's
    //     over-acceptance finding), so the gate did not just get looser.
    // ------------------------------------------------------------------

    it('accepts a brief whose done-ness is an explicit output shape rather than a modal verb', async () => {
        const seen: HarnessStreamRequest[] = [];
        const researcher = brain(scripted([answer('summarised')], seen));
        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    '{"agent":"researcher","input":"Summarize the file README.md in three bullets.","requireClarification":true}'
                ),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        // Accepted: the child ran, so the caller paid no round trip for a `done when` clause
        // that would have added nothing the child could not already do.
        expect(seen).toHaveLength(1);
        expect(answerOf(writerAgent.messages[2])).toEqual({ agent: 'researcher', content: 'summarised' });
    });

    it('refuses an acceptance-worded brief that names no target, and names only the target', async () => {
        const seen: HarnessStreamRequest[] = [];
        const researcher = brain(scripted([answer('should not run')], seen));
        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    '{"agent":"researcher","input":"Make the module such that it must pass the tests.","requireClarification":true}'
                ),
                answer('recovered')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        const refusal = content(writerAgent.messages[2]);

        expect(refusal).toContain('is under-specified');
        expect(refusal).toContain('concrete target');
        // The criterion IS stated (`must pass`), so the refusal must not claim otherwise — a
        // caller that reads one half of the list should not go and restate the other half.
        expect(refusal).not.toContain('acceptance criterion');
        expect(seen).toHaveLength(0);
    });

    it('refuses a brief whose only acceptance signal is a causal word', async () => {
        const seen: HarnessStreamRequest[] = [];
        const researcher = brain(scripted([answer('should not run')], seen));
        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    '{"agent":"researcher","input":"Refactor `src/parse.ts` because it is long.","requireClarification":true}'
                ),
                answer('recovered')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        const refusal = content(writerAgent.messages[2]);

        expect(refusal).toContain('is under-specified');
        expect(refusal).toContain('acceptance criterion');
        // The target is named (a quoted path), so it is not reported as missing.
        expect(refusal).not.toContain('concrete target');
        expect(seen).toHaveLength(0);
    });

    it('names both missing parts for a brief that states neither a target nor a criterion', async () => {
        const seen: HarnessStreamRequest[] = [];
        const researcher = brain(scripted([answer('should not run')], seen));
        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    '{"agent":"researcher","input":"Make it better.","requireClarification":true}'
                ),
                answer('recovered')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        const refusal = content(writerAgent.messages[2]);

        expect(refusal).toContain('concrete target');
        expect(refusal).toContain('acceptance criterion');
        // AC3: the remedy no longer insists on a `done when` clause specifically.
        expect(refusal).not.toContain('done when');
        expect(seen).toHaveLength(0);
    });

    it('reports a cancelled child as a structured result instead of an empty record', async () => {
        // A child that commits a substantive turn and then hangs inside a tool: the run
        // is cancelled mid-flight, which is exactly the case the transcript rollback
        // used to erase. (A cancel DURING a stream commits nothing — the assistant
        // message only lands at `done` — so the hang has to be in a tool call for there
        // to be committed text to preserve.)
        let release!: () => void;
        const hang = new Promise<void>((resolve) => {
            release = resolve;
        });

        const researcher = brain(
            scripted([
                [
                    { type: 'text', delta: 'half an answer' },
                    {
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [{ id: 'r1', name: 'hang', arguments: '{}' }]
                    }
                ],
                answer('never reached')
            ])
        );

        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"find facts"}'),
                answer('final')
            ])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher },
            tools: {
                hang: tool({
                    description: 'Hang until the run is cancelled.',
                    tags: ['test'],
                    visibility: 'core',
                    execute: () => hang.then(() => 'released')
                })
            },
            presets: false
        });

        const controller = new AbortController();
        const running = writer('go', { signal: controller.signal });

        // Let the child commit its turn and reach the hanging tool, then stop the run.
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.abort(new Error('operator stop'));
        release();

        await expect(running).rejects.toThrow('operator stop');

        // The child's own record survives the rollback: how far it got, and what it had
        // already said. This is the forensic half of the fix — the transcript is gone,
        // but the account of the run is not.
        const stored = (await writer.executeTool('agentResult', { agent: 'researcher' })) as {
            status: string;
            content: string;
            cancelledAtMessage?: number;
            error?: string;
        };

        expect(stored.status).toBe('cancelled');
        expect(stored.content).toBe('half an answer');
        expect(stored.cancelledAtMessage).toBeGreaterThan(0);
        expect(stored.error).toContain('operator stop');
    });
});

// ---------------------------------------------------------------------------
// Issue 0028 AC3 — WHICH conversation a delegated child runs in, pinned in BOTH
// directions by behaviour rather than by description text
// ---------------------------------------------------------------------------
//
// The `delegate` descriptions promise a fresh conversation per delegation, and the runtime
// really does branch on the PARENT's conversation kind (`src/harness.ts:12350-12368`):
//   - a parent that is itself an independent host conversation (`createThread`, record
//     origin 'host') MINTS a new child thread per delegation — `createThreadState` at
//     `:12360`, linked to the caller with `ownerThreadId` — so siblings never share a
//     transcript even when they target the same agent;
//   - a parent with no thread of its own (a host-driven session: the primary invoked
//     directly, which binds it to its DEFAULT conversation, origin 'agent') falls through to
//     `defaultThreadOf` at `:12367`, so EVERY delegation to one subagent re-enters that
//     subagent's standing `agent:<name>` conversation and a second child really does see
//     what it answered the first time.
// Only the single-delegation case was pinned (`:1038`, `:1577`), so either direction could
// be inverted with the suite green — which is how the prose drifted into promising
// unconditional freshness. "Remembers" is not hidden state here: it is observable as the
// message list the NEXT model request carries, so both tests assert that list end to end.
// Every expected value below was measured from these exact scenarios, not inferred.
describe('delegation conversation continuity, both directions (issue 0028 AC3)', () => {
    // The envelope a call ended with, minus the one field no assertion here owns. The file's
    // `envelopeOfCall` (:268) returns the whole JSON; `durationMs` is measured, so it is
    // checked for type only and dropped, exactly as the 0029 block does at :1368.
    const envelopeWithoutClock = (messages: readonly unknown[], callId: string): Record<string, unknown> => {
        const { durationMs, ...rest } = envelopeOfCall(messages, callId);

        expect(durationMs).toEqual(expect.any(Number));

        return rest;
    };

    // The transcript as the CHILD model receives it: role plus text, messageIds stripped
    // (`withoutIds`, :53) because an id is an address, not content.
    const requestsOf = (requests: readonly HarnessStreamRequest[]) =>
        requests.map((request) =>
            request.messages.map((message) => ({ role: message.role, content: message.content }))
        );

    it('re-enters the same child conversation when a host-driven session delegates twice', async () => {
        const childRequests: HarnessStreamRequest[] = [];
        const researcher = brain(scripted([answer('facts one'), answer('facts two')], childRequests), {
            instruction: 'You are a researcher.'
        });
        // Two delegate turns, then the answer: each turn is a separate model REQUEST of the
        // parent, so the first child has fully finished before the second one starts.
        const writerAgent = brain(
            scripted([
                callTool('d1', 'delegate', JSON.stringify({ agent: 'researcher', input: 'brief one' })),
                callTool('d2', 'delegate', JSON.stringify({ agent: 'researcher', input: 'brief two' })),
                answer('final')
            ]),
            { instruction: 'You are a writer.' }
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });

        await writer('go');

        // SAME conversation id, DIFFERENT run ids: the second delegation was another turn of
        // `agent:researcher`, not a new conversation.
        expect(envelopeWithoutClock(writerAgent.messages, 'd1')).toEqual({
            agent: 'researcher',
            content: 'facts one',
            contentLength: 9,
            offset: 0,
            limit: 8000,
            truncated: false,
            invocationId: '2',
            threadId: 'agent:researcher',
            status: 'completed'
        });
        expect(envelopeWithoutClock(writerAgent.messages, 'd2')).toEqual({
            agent: 'researcher',
            content: 'facts two',
            contentLength: 9,
            offset: 0,
            limit: 8000,
            truncated: false,
            invocationId: '3',
            threadId: 'agent:researcher',
            status: 'completed'
        });

        // No child thread was minted at all: delegating twice from the host still leaves only
        // the two default conversations in the session.
        expect(writer.threads().map((record) => [record.id, record.origin])).toEqual([
            ['agent:writer', 'agent'],
            ['agent:researcher', 'agent']
        ]);

        // The standing conversation accumulated BOTH exchanges, in order.
        expect(withoutIds(researcher.messages)).toEqual([
            { role: 'system', content: 'You are a researcher.' },
            { role: 'user', content: 'brief one' },
            { role: 'assistant', content: 'facts one' },
            { role: 'user', content: 'brief two' },
            { role: 'assistant', content: 'facts two' }
        ]);

        // THE PIN: the second request carried the first brief and the first answer, so the
        // child of the second delegation really does remember the first one.
        expect(requestsOf(childRequests)).toEqual([
            [
                { role: 'system', content: 'You are a researcher.' },
                { role: 'user', content: 'brief one' }
            ],
            [
                { role: 'system', content: 'You are a researcher.' },
                { role: 'user', content: 'brief one' },
                { role: 'assistant', content: 'facts one' },
                { role: 'user', content: 'brief two' }
            ]
        ]);

        await writer.dispose();
    });

    it('mints two independent child conversations for a threaded parent, neither of which remembers the other', async () => {
        const childRequests: HarnessStreamRequest[] = [];
        const researcher = brain(scripted([answer('facts one'), answer('facts two')], childRequests), {
            instruction: 'You are a researcher.'
        });
        // Two host sends of the SAME thread, each delegating once. `scripted` counts REQUESTS,
        // so one send consumes two entries (the tool call, then the answer) and the second
        // send continues the same parent conversation with entries 3 and 4.
        const writerAgent = brain(
            scripted([
                callTool('d1', 'delegate', JSON.stringify({ agent: 'researcher', input: 'brief one' })),
                answer('first done'),
                callTool('d2', 'delegate', JSON.stringify({ agent: 'researcher', input: 'brief two' })),
                answer('second done')
            ]),
            { instruction: 'You are a writer.' }
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        const parent = writer.createThread('writer');

        await writer.sendThreadInput(parent.id, 'first task');
        await writer.sendThreadInput(parent.id, 'second task');

        const parentMessages = writer.threadMessages(parent.id);

        // Two DIFFERENT minted conversations, addressed by two different ids.
        expect(envelopeWithoutClock(parentMessages, 'd1')).toEqual({
            agent: 'researcher',
            content: 'facts one',
            contentLength: 9,
            offset: 0,
            limit: 8000,
            truncated: false,
            invocationId: '2',
            threadId: 'thread-2',
            status: 'completed'
        });
        expect(envelopeWithoutClock(parentMessages, 'd2')).toEqual({
            agent: 'researcher',
            content: 'facts two',
            contentLength: 9,
            offset: 0,
            limit: 8000,
            truncated: false,
            invocationId: '4',
            threadId: 'thread-3',
            status: 'completed'
        });

        // The roster is the proof of minting, not the envelope: `thread-2` and `thread-3` are
        // separate host conversations owned by `thread-1`, and the invocation ids pair each
        // child with its own run.
        expect(
            writer.threads().map((record) => [record.id, record.origin, record.ownerThreadId, record.invocationId])
        ).toEqual([
            ['agent:writer', 'agent', undefined, undefined],
            ['agent:researcher', 'agent', undefined, undefined],
            ['thread-1', 'host', undefined, '3'],
            ['thread-2', 'host', 'thread-1', '2'],
            ['thread-3', 'host', 'thread-1', '4']
        ]);

        // Each child holds exactly its OWN exchange …
        expect(withoutIds(writer.threadMessages('thread-2'))).toEqual([
            { role: 'system', content: 'You are a researcher.' },
            { role: 'user', content: 'brief one' },
            { role: 'assistant', content: 'facts one' }
        ]);
        expect(withoutIds(writer.threadMessages('thread-3'))).toEqual([
            { role: 'system', content: 'You are a researcher.' },
            { role: 'user', content: 'brief two' },
            { role: 'assistant', content: 'facts two' }
        ]);

        // … and neither request carried the other's brief: isolation, asserted as what the
        // child was actually shown.
        expect(requestsOf(childRequests)).toEqual([
            [
                { role: 'system', content: 'You are a researcher.' },
                { role: 'user', content: 'brief one' }
            ],
            [
                { role: 'system', content: 'You are a researcher.' },
                { role: 'user', content: 'brief two' }
            ]
        ]);

        // The asymmetry with the host case, stated as data: a threaded parent never touches the
        // subagent's standing conversation, which stays at its seeded system prompt.
        expect(withoutIds(writer.threadMessages('agent:researcher'))).toEqual([
            { role: 'system', content: 'You are a researcher.' }
        ]);

        await writer.dispose();
    });
});

// ---------------------------------------------------------------------------
// Issues 0029 and 0021 — the identity an envelope reports belongs to the child THIS
// call started, and a delegation released by `toolCancel` still delivers its result
// ---------------------------------------------------------------------------
//
// Both defects are one problem: a `delegate` result is computed by a run the CALLER does
// not hold.
//
//   D1 (0029) — the identity used to be REDISCOVERED after the child resolved: "the record
//   whose `parentCallId` equals my call id", else "the newest record for that agent I had
//   not seen at dispatch". A tool-call id is unique only WITHIN one run, and a second run of
//   the same agent genuinely overlaps a delegation (a host thread queues on its own actor,
//   not on the agent's default conversation), so either rule can name a run this call never
//   started — and the caller reports another run's `invocationId`, `threadId` AND `status`.
//   The child run now CARRIES its identity out through `context.run(..., { identity })`, so
//   the ledger entry is ADDRESSED by that id and only verified afterwards.
//
//   D2 (0021) — `toolCancel` releases the call synchronously (JavaScript cannot be
//   preempted) and the scheduler treats the child's late resolution as data on a dead task.
//   The envelope this call computed was therefore produced and DISCARDED: the caller read
//   "no result is available" and had to spend a second call on forensics that already
//   existed in the child's terminal record.
describe('delegation identity by value and cancel delivery (0029, 0021)', () => {
    // The envelope with its ONE measured number pulled out (no assertion here owns elapsed
    // time — the T28 contract test above pins it with `expect.any`). Accepts either the value
    // a manual `executeTool('delegate')` hands back, or a transcript message whose `content`
    // is the delivered JSON.
    const envelopeOf = (value: unknown): Record<string, unknown> => {
        const candidate =
            (value as { role?: unknown } | undefined)?.role === undefined ? value : content(value);
        const parsed = (typeof candidate === 'string'
            ? JSON.parse(candidate)
            : candidate) as Record<string, unknown>;
        const { durationMs, ...rest } = parsed;

        expect(durationMs).toEqual(expect.any(Number));

        return rest;
    };

    // The message a tool call ended up with, so an assertion names the CALL rather than a
    // transcript index that moves when the turn shape changes.
    const toolMessageOf = (brain: Agent, callId: string): Record<string, any> =>
        brain.messages.find(
            (message) => (message as Record<string, any>).role === 'tool' && (message as Record<string, any>).toolCallId === callId
        ) as Record<string, any>;

    // This file's `scripted` helper counts TURNS in one closure, so two concurrent runs of
    // the SAME Agent consume each other's turns. Every stream below answers from the REQUEST
    // instead: that is what makes the interleaving below deterministic.
    const answersFromRequest = (textFor: (input: string) => string): HarnessStream =>
        (async function* stream(request: HarnessStreamRequest) {
            const answered = request.messages.some((message) => (message as Record<string, any>).role === 'tool');
            const input = String(
                request.messages.find((message) => (message as Record<string, any>).role === 'user')?.content ?? ''
            );
            const text = textFor(input);

            if (!answered) {
                yield { type: 'text', delta: `half of ${text}` };
                yield {
                    type: 'done',
                    stopReason: 'tool_calls',
                    toolCalls: [{ id: 'hold-1', name: 'hold', arguments: '{}' }]
                };
                return;
            }

            yield { type: 'text', delta: text };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        } as unknown) as HarnessStream;

    const holdTool = (gate: Promise<void>) =>
        tool({
            description: 'Hold until the test releases it.',
            tags: ['test'],
            visibility: 'core',
            execute: () => gate.then(() => 'released')
        });

    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

    it('names the child THIS call started while a host thread of the same agent runs alongside', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));

        const writer = harness({
            agents: {
                writer: brain(scripted([answer('final')])),
                researcher: brain(
                    answersFromRequest((input) => (input === 'thread task' ? 'the thread answer' : 'the delegated answer'))
                )
            },
            tools: { hold: holdTool(gate) },
            presets: false
        });

        // The MANUAL `executeTool` door: it carries no `callId` and no `runScope`, so before
        // the carrier existed this call had exactly one rule left — "the newest record for
        // that agent that did not exist when I dispatched".
        const delegated = writer.executeTool('delegate', { agent: 'researcher', input: 'find facts' });

        // A second run of the SAME agent, started while the first is still inside its tool.
        // A host thread owns its own actor, so it really does overlap the delegated
        // conversation — and it registers its ledger entry in the same window.
        const thread = writer.createThread('researcher');
        const sibling = writer.sendThreadInput(thread.id, 'thread task');

        await settle();
        release();

        expect(envelopeOf(await delegated)).toEqual({
            agent: 'researcher',
            content: 'the delegated answer',
            contentLength: 20,
            offset: 0,
            limit: 8000,
            truncated: false,
            // THE POINT OF THE TEST. `'1'` is the delegated child (its conversation is the
            // agent's DEFAULT thread); `'2'` is the host thread's run. Measured on the
            // pre-carrier code, this same scenario reported the sibling instead —
            // `invocationId: '2'`, `threadId: 'thread-1'` — an identity, a conversation and a
            // status this call never had.
            invocationId: '1',
            threadId: 'agent:researcher',
            status: 'completed'
        });

        expect((await sibling).content).toBe('the thread answer');

        // The sibling's record still exists and is still its OWN — the fix stopped
        // misreporting it, it did not merge or drop it. `agentManage` is the caller's view of
        // the same ledger, asserted whole.
        expect(await writer.executeTool('agentManage', {})).toEqual({
            agents: [
                { name: 'writer', role: 'primary', model: 'merge/ds4-flash', invocationCount: 0, results: [] },
                {
                    name: 'researcher',
                    role: 'subagent',
                    model: 'merge/ds4-flash',
                    invocationCount: 2,
                    results: [
                        {
                            invocationId: '2',
                            kind: 'root',
                            status: 'completed',
                            contentLength: 17,
                            preview: 'the thread answer',
                            truncated: false
                        },
                        {
                            invocationId: '1',
                            kind: 'root',
                            status: 'completed',
                            contentLength: 20,
                            preview: 'the delegated answer',
                            truncated: false
                        }
                    ]
                }
            ],
            totalResults: 2,
            activeResults: 0,
            truncated: false
        });

        await writer.dispose();
    });

    it('keeps two parents that share a tool-call id pointed at different children', async () => {
        const writerAgent = brain(
            (async function* stream(request: HarnessStreamRequest) {
                const answered = request.messages.some((message) => (message as Record<string, any>).role === 'tool');

                if (!answered) {
                    // BOTH conversations of this one Agent write the SAME call id (`c1`) —
                    // legal, because a call id is scoped to its run — and delegate to a
                    // different subagent each time.
                    const input = String(
                        request.messages.find((message) => (message as Record<string, any>).role === 'user')?.content ?? ''
                    );

                    yield {
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [
                            {
                                id: 'c1',
                                name: 'delegate',
                                arguments: JSON.stringify({
                                    agent: input === 'route A' ? 'researcher' : 'critic',
                                    input: `review ${input}`
                                })
                            }
                        ]
                    };
                    return;
                }

                const result = String(
                    request.messages.filter((message) => (message as Record<string, any>).role === 'tool').pop()?.content ?? ''
                );

                yield { type: 'text', delta: `done: ${(JSON.parse(result) as { content: string }).content}` };
                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
            } as unknown) as HarnessStream
        );

        const writer = harness({
            agents: {
                writer: writerAgent,
                researcher: brain(scripted([answer('the facts')])),
                critic: brain(scripted([answer('the verdict')]))
            },
            presets: false
        });

        const first = writer('route A');
        const thread = writer.createThread('writer');
        const second = writer.sendThreadInput(thread.id, 'route B');

        await first;
        expect((await second).content).toBe('done: the verdict');

        // Each parent names ITS OWN child: the ids, conversations and answers are paired, and
        // neither envelope can be the other's (the pre-carrier pair match keyed on
        // `parentCallId` alone was one missing `parentScope` check away from getting this
        // backwards for a parent that has no scope).
        expect(envelopeOf(toolMessageOf(writerAgent, 'c1'))).toEqual({
            agent: 'researcher',
            content: 'the facts',
            contentLength: 9,
            offset: 0,
            limit: 8000,
            truncated: false,
            invocationId: '3',
            threadId: 'agent:researcher',
            status: 'completed'
        });

        const threadToolMessage = (writer.threadMessages(thread.id) as Record<string, any>[]).find(
            (message) => message.role === 'tool' && message.toolCallId === 'c1'
        );

        expect(envelopeOf(threadToolMessage)).toEqual({
            agent: 'critic',
            content: 'the verdict',
            contentLength: 11,
            offset: 0,
            limit: 8000,
            truncated: false,
            invocationId: '4',
            threadId: 'thread-2',
            status: 'completed'
        });

        await writer.dispose();
    });

    it('delivers the child forensics when toolCancel releases the delegation', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));

        const researcher = brain(
            scripted([
                [
                    { type: 'text', delta: 'half an answer' },
                    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id: 'r1', name: 'hold', arguments: '{}' }] }
                ],
                answer('never reached')
            ])
        );
        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"find facts"}'),
                callTool('c2', 'toolCancel', '{"callId":"c1"}'),
                answer('final')
            ])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher },
            tools: { hold: holdTool(gate) },
            presets: false
        });

        const running = writer('go');
        await settle();
        await running;
        release();
        await settle();

        // ONE tool message for `c1`, classified as the control outcome it was, and it carries
        // the child's terminal record instead of the "no result is available" sentence: the
        // answer the child managed to finish (here, none — its text was rolled back with the
        // run), the partial text it had said, how far it got, and the identity of the exact
        // invocation that produced them.
        expect(envelopeOf(toolMessageOf(writerAgent, 'c1'))).toEqual({
            agent: 'researcher',
            content: 'half an answer',
            contentLength: 14,
            offset: 0,
            limit: 8000,
            truncated: false,
            invocationId: '2',
            threadId: 'agent:researcher',
            status: 'cancelled',
            // A harness-raised reason naming the agent and the cause. The child's OWN record
            // keeps its raw abort string (asserted below) — 0021 AC1 asks for the classifiable
            // wording on the door the CALLER used, and `agentResult` stays the child's account.
            error: 'Delegation to "researcher" was cancelled by the caller before the call returned.',
            partialContent: 'half an answer',
            cancelledAtMessage: 2,
            callCancelled: true
        });

        expect(toolMessageOf(writerAgent, 'c1').outcome).toBe('cancelled');

        // The `toolCancel` control is untouched: same acknowledgement, byte for byte, and the
        // released call still keeps exactly one result (0021 AC3).
        expect(content(toolMessageOf(writerAgent, 'c2'))).toBe(
            '{"cancelled":true,"callId":"c1","name":"delegate"}'
        );
        expect(writerAgent.messages.filter((message) => (message as Record<string, any>).role === 'tool').length).toBe(2);

        // The delivered bytes and the ledger agree: the same invocation reads the same status,
        // the same partial answer and the same progress marker through `agentResult` (0019 AC3).
        const stored = (await writer.executeTool('agentResult', {
            agent: 'researcher',
            invocationId: '2'
        })) as Record<string, any>;

        expect({
            status: stored.status,
            content: stored.content,
            partialContent: stored.partialContent,
            cancelledAtMessage: stored.cancelledAtMessage
        }).toEqual({
            status: 'cancelled',
            content: 'half an answer',
            partialContent: 'half an answer',
            cancelledAtMessage: 2
        });

        // The child's own wording is still what the record holds — the raw abort primitive
        // 0021 also names. Replacing it is the record's business, not this door's, so it is
        // pinned here to make that boundary explicit.
        expect(stored.error).toBe('This operation was aborted');

        await writer.dispose();
    });
});

// ---------------------------------------------------------------------------
// T28 — a delegation CAN be bounded in wall-clock time
// ---------------------------------------------------------------------------
//
// ORIGINAL HEADING: "a delegation is bounded in wall-clock time". That is now the
// OPTIONAL behaviour, not the default: as of 2026-11-09 an omitted `timeoutMs` arms
// no clock at all (see `delegation time limits (policy 2026-11-09)` below). This
// block stays exactly as written because it is the R5 proof — the mechanism survives,
// its default changed — and policy doc T5.2 asks for it to be EXTENDED, not replaced.
//
// Before this, a child that ran `sleep 600` sat `running` indefinitely: nothing in
// the schema capped wall-clock, and the only recovery was `toolCancel` — which then
// destroyed the transcript. `timeoutMs` bounds the CHILD only, so the parent turn
// still receives a structured result instead of rolling back.
describe('delegation timeout (T28)', () => {
    it('stops a frozen child and reports its partial work', async () => {
        let release!: () => void;
        const hang = new Promise<void>((resolve) => {
            release = resolve;
        });

        const researcher = brain(
            scripted([
                [
                    { type: 'text', delta: 'started the work' },
                    {
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [{ id: 'r1', name: 'hang', arguments: '{}' }]
                    }
                ],
                answer('never reached')
            ])
        );

        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    '{"agent":"researcher","input":"find facts","timeoutMs":30}'
                ),
                answer('recovered')
            ])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher },
            tools: {
                hang: tool({
                    description: 'Hang until released.',
                    tags: ['test'],
                    visibility: 'core',
                    execute: () => hang.then(() => 'released')
                })
            },
            presets: false
        });

        const message = await writer('go');
        release();

        // The parent recovered with an answer, and the delegation is a readable result
        // rather than a hang or a thrown error.
        expect(message.content).toBe('recovered');

        const result = delegationOf(writerAgent.messages[2]);

        expect(result).toMatchObject({
            agent: 'researcher',
            status: 'cancelled',
            content: 'started the work',
            partialContent: 'started the work'
        });
        expect(result.error).toContain('exceeded its 30ms timeout');
        expect(result.cancelledAtMessage).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// T28 — a delegation can scope what the child may do
// ---------------------------------------------------------------------------
//
// `delegate` had no scope declaration, so a "planning" agent could write a 58 KB
// artifact into the user's checkout. `scope.tools` is an allowlist enforced on the
// child: it neither SEES nor can CALL anything outside it.
describe('delegation scope (T28)', () => {
    it('hides and refuses every capability outside the allowlist except the discovery door', async () => {
        const seen: HarnessStreamRequest[] = [];
        const researcher = brain(
            scripted(
                [
                    // The child tries a tool it was not granted.
                    callTool('r1', 'write', '{"path":"leak.txt","content":"x"}'),
                    answer('scoped answer')
                ],
                seen
            )
        );

        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    '{"agent":"researcher","input":"review src/a.ts","scope":{"tools":["read"]}}'
                ),
                answer('final')
            ])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher },
            tools: {
                read: tool({
                    description: 'Read.',
                    tags: ['files'],
                    visibility: 'core',
                    execute: () => 'contents'
                }),
                write: tool({
                    description: 'Write.',
                    tags: ['files'],
                    visibility: 'core',
                    execute: () => 'written'
                })
            },
            presets: false
        });

        await writer('go');

        // The child SAW only its allowlist plus the one tool the scope can never
        // block: `toolRequest` is the escape hatch (delegate-stress finding 2), so a
        // restricted child can always name the capability it is missing instead of
        // looping. `task` is filtered out — the allowlist still bounds every capability.
        expect(declaredNames(seen[0])).toEqual(['toolRequest', 'read']);

        // The guessed call was refused with a readable result, and the run continued.
        const refusal = researcher.messages.find(
            (message) => message.role === 'tool' && message.toolCallId === 'r1'
        ) as { content: string };

        expect(refusal.content).toContain('is outside this run\'s scope');
        expect(refusal.content).toContain('Allowed: read');
        expect(answerOf(writerAgent.messages[2])).toEqual({
            agent: 'researcher',
            content: 'scoped answer'
        });
    });

    it('declares only the discovery door for an empty allowlist', async () => {
        const seen: HarnessStreamRequest[] = [];
        const researcher = brain(scripted([answer('reasoned')], seen));
        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    '{"agent":"researcher","input":"think about src/a.ts","scope":{"tools":[]}}'
                ),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        // A pure-reasoning child: no capability declarations, so it cannot touch the
        // workspace. The ONE entry is `toolRequest` — the escape hatch the scope can
        // never remove (delegate-stress finding 2), so even a zero-tool child has a
        // way to report what it needs instead of producing nothing at all.
        expect(declaredNames(seen[0])).toEqual(['toolRequest']);
        expect(answerOf(writerAgent.messages[2])).toEqual({ agent: 'researcher', content: 'reasoned' });
    });

    // -------------------------------------------------------------------------
    // delegate-stress finding 2 (docs/tasks/2026-11-08-delegate-stress-test.md) —
    // `scope` gated `toolRequest` itself, which livelocked a restricted child. A
    // child scoped to `["read","glob"]` and briefed to write "ran 45 messages over
    // 132 s" looping on glob, because the one instruction its prompt gives for a
    // missing capability ("call toolRequest before concluding it cannot be done")
    // could not be honoured. The fix is the escape hatch: `toolRequest` is declared
    // and callable no matter what the allowlist names, while every capability the
    // scope omits stays hidden AND stays refused at launch.
    // -------------------------------------------------------------------------
    it('lets a scoped child call toolRequest, the one tool the allowlist cannot block', async () => {
        const seen: HarnessStreamRequest[] = [];

        // The child does exactly what the finding says a scoped child could not: ask
        // discovery for the capability it is missing, then answer about it.
        const researcher = brain(
            scripted(
                [
                    callTool('r1', 'toolRequest', '{"names":["write"]}'),
                    answer('write is not available to me')
                ],
                seen
            )
        );

        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    '{"agent":"researcher","input":"write one file","scope":{"tools":["read","glob"]}}'
                ),
                answer('final')
            ])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher },
            tools: {
                read: tool({
                    description: 'Read.',
                    tags: ['files'],
                    visibility: 'core',
                    execute: () => 'contents'
                }),
                glob: tool({
                    description: 'Glob.',
                    tags: ['files'],
                    visibility: 'core',
                    execute: () => 'a.ts'
                }),
                write: tool({
                    description: 'Write.',
                    tags: ['files'],
                    visibility: 'searchable',
                    execute: () => 'written'
                })
            },
            presets: false
        });

        await writer('go');

        // 1. Declared: the allowlist is `read`/`glob`, and `toolRequest` is there
        //    anyway (in registry order, ahead of the scoped capability).
        expect(declaredNames(seen[0])).toEqual(['toolRequest', 'read', 'glob']);

        // 2. Callable: the discovery call ANSWERED (no scope refusal), so the child got
        //    a real result to reason about rather than a dead end.
        const discovery = researcher.messages.find(
            (message) => message.role === 'tool' && message.toolCallId === 'r1'
        ) as { content: string };

        // 2. Callable: the discovery call ANSWERED (no scope REFUSAL — the tool call
        //    itself ran), so the child got a real result to reason about rather than a
        //    dead end. T11: the answer is now an explicit DENIAL, not an `enabled`
        //    promise. `write` is searchable and matched, but the run's scope excludes
        //    it, so it is reported under `forbidden` with the launch gate's own
        //    sentence and the allowed list — and it was never added to the enabled set
        //    (the session-wide pollution the old shape caused is gone). The exact JSON
        //    below is also the proof the call was not refused: a launch-gate refusal is
        //    plain text and would not parse to this discovery envelope at all.
        expect(JSON.parse(discovery.content)).toEqual({
            enabled: [],
            tools: [],
            matched: 1,
            omitted: 0,
            forbidden: [
                {
                    name: 'write',
                    reason:
                        "Tool \"write\" is outside this run's scope. Allowed: read, glob. Requesting it again will not change this answer — adapt to the allowed tools or report the limitation.",
                    allowed: ['read', 'glob']
                }
            ]
        });

        // 3. Still scoped: the escape hatch opens the discovery door only. A tool the
        //    allowlist omits stays uncalled — the finding's "no clean denial to fail
        //    on" is answered by the sibling test above, which asserts the readable
        //    `is outside this run's scope` refusal for a guessed capability call.
        const childAnswer = delegationOf(writerAgent.messages[2]);
        expect(childAnswer).toMatchObject({
            agent: 'researcher',
            content: 'write is not available to me',
            status: 'completed'
        });
    });

    // -------------------------------------------------------------------------
    // T11 (RR4 loop) — toolRequest must answer a SCOPED run honestly.
    //
    // The escape hatch kept `toolRequest` callable from a scoped child, but the answer
    // itself was scope-BLIND: an out-of-scope match came back under `enabled`, the very
    // next declaration list hid the tool again (the scope filter is correct), and a
    // guessed call hit the launch-gate refusal. RR4 answered that contradiction by
    // re-requesting — 135 round-trips, 5.6k→152k tokens — and every such enable also
    // landed in the SESSION-wide enabled set, leaking the child's discovery into every
    // sibling thread. The tests below pin the three contract halves: the denial shape
    // and its determinism, the untouched enabled set, and the unchanged in-scope path.
    // -------------------------------------------------------------------------

    // One builder for the two denial tests: the same scoped writer/researcher pair as
    // the escape-hatch test; only the allowlist and the child's script vary. `scope`
    // is passed as the delegate arguments so a test can name a scope that hides even a
    // core tool (the `alreadyAvailable` half of the T11 fix).
    const scopedDiscoveryPair = (
        childScript: HarnessStreamEvent[][],
        scope: string,
        seenChild: HarnessStreamRequest[]
    ) => {
        const researcher = brain(scripted(childScript, seenChild));
        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    `{"agent":"researcher","input":"need write","scope":{"tools":${scope}}}`
                ),
                answer('final')
            ])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher },
            tools: {
                read: tool({
                    description: 'Read.',
                    tags: ['files'],
                    visibility: 'core',
                    execute: () => 'contents'
                }),
                glob: tool({
                    description: 'Glob.',
                    tags: ['files'],
                    visibility: 'core',
                    execute: () => 'a.ts'
                }),
                write: tool({
                    description: 'Write.',
                    tags: ['files'],
                    visibility: 'searchable',
                    execute: () => 'written'
                })
            },
            presets: false
        });

        return { writer, writerAgent, researcher };
    };

    it('denies an out-of-scope request with the allowed list, twice identically, and never touches the enabled set (T11)', async () => {
        // The loop-prevention regression: TWO consecutive rounds asking for the same
        // out-of-scope tool. Both answers are byte-identical (the denial is a pure
        // function of request + scope, no state can flip it), the tool never reaches
        // the next turn's declarations, and `discoveredTools` — the session-wide
        // enabled set that used to gain `write` from the child's doomed enable — stays
        // empty.
        const seenChild: HarnessStreamRequest[] = [];
        const { writer, researcher } = scopedDiscoveryPair(
            [
                callTool('w1', 'toolRequest', '{"names":["write"]}'),
                callTool('w2', 'toolRequest', '{"names":["write"]}'),
                answer('write is forbidden here')
            ],
            '["read","glob"]',
            seenChild
        );

        await writer('go');

        const expected = {
            enabled: [],
            tools: [],
            matched: 1,
            omitted: 0,
            forbidden: [
                {
                    name: 'write',
                    reason:
                        "Tool \"write\" is outside this run's scope. Allowed: read, glob. Requesting it again will not change this answer — adapt to the allowed tools or report the limitation.",
                    allowed: ['read', 'glob']
                }
            ]
        };

        const toolResults = researcher.messages.filter((message) => message.role === 'tool');
        const first = JSON.parse((toolResults[0] as { content: string }).content);
        const second = JSON.parse((toolResults[1] as { content: string }).content);

        // Round 1 and round 2: the SAME honest denial — deterministic, no flip.
        expect(first).toEqual(expected);
        expect(second).toEqual(expected);
        expect(second).toEqual(first);

        // The escape hatch is untouched: the child was never blocked from asking (no
        // launch-gate refusal on either round — the denial lives INSIDE the discovery
        // envelope, which only an executed toolCall produces).
        expect(toolResults).toHaveLength(2);

        // The very next model request still declares only the allowlist plus the
        // discovery door: the denial did not declare `write`, and the enabled set did
        // not grow behind the scope filter (both would have put `write` in this list in
        // an unscoped run).
        expect(declaredNames(seenChild[1])).toEqual(['toolRequest', 'read', 'glob']);

        // R1, no-pollution half: the session-wide enabled set is exactly what it was —
        // empty. Before T11 this read ['write'] even though the child could never call
        // it, and every sibling thread inherited the leak.
        expect(writer.discoveredTools).toEqual([]);
    });

    it('moves an out-of-scope CORE tool from alreadyAvailable to forbidden (T11)', async () => {
        // The lie was not only in `enabled`. A core tool the agent can SEE but the run
        // scope HIDES used to be reported under `alreadyAvailable` — "you can call this
        // right now" — while the launch gate refused it. Same predicate, same honest
        // answer: it moves to `forbidden` and `alreadyAvailable` drops.
        const { writer, researcher } = scopedDiscoveryPair(
            [callTool('w1', 'toolRequest', '{"names":["read","write"]}'), answer('done')],
            '["glob"]',
            []
        );

        await writer('go');

        const toolResults = researcher.messages.filter((message) => message.role === 'tool');
        const answer1 = JSON.parse((toolResults[0] as { content: string }).content);

        // One query, both halves of the denial: the searchable `write` (an enable
        // candidate the scope hides) and the CORE `read` (an `alreadyAvailable` hit the
        // scope hides). Capability denials lead, core denials follow, both in selection
        // order; neither is enabled, and `alreadyAvailable` is absent because its only
        // match was the denied core tool.
        expect(answer1).toEqual({
            enabled: [],
            tools: [],
            matched: 1,
            omitted: 0,
            forbidden: [
                {
                    name: 'write',
                    reason:
                        "Tool \"write\" is outside this run's scope. Allowed: glob. Requesting it again will not change this answer — adapt to the allowed tools or report the limitation.",
                    allowed: ['glob']
                },
                {
                    name: 'read',
                    reason:
                        "Tool \"read\" is outside this run's scope. Allowed: glob. Requesting it again will not change this answer — adapt to the allowed tools or report the limitation.",
                    allowed: ['glob']
                }
            ]
        });

        // The denial promised nothing anywhere: the session-wide enabled set is empty.
        expect(writer.discoveredTools).toEqual([]);
    });

    it('keeps the in-scope toolRequest answer byte-for-byte historical in a scoped run (T11 R2)', async () => {
        // R2's scoped half: an allowlisted SEARCHABLE tool still enables exactly like an
        // unscoped request would — same fields, same values, NO `forbidden` key (the
        // `toEqual` below is exact; a stray field would fail it). The session-wide
        // enabled set gains it, because an in-scope grant is still a real grant.
        const seenChild: HarnessStreamRequest[] = [];
        const { writer, researcher } = scopedDiscoveryPair(
            [callTool('w1', 'toolRequest', '{"names":["write"]}'), answer('writing now')],
            '["read","glob","write"]',
            seenChild
        );

        await writer('go');

        const toolResults = researcher.messages.filter((message) => message.role === 'tool');

        expect(JSON.parse((toolResults[0] as { content: string }).content)).toEqual({
            enabled: ['write'],
            tools: [{ name: 'write', description: 'Write.', tags: ['files'] }],
            matched: 1,
            omitted: 0
        });

        // The grant is live for this run: `write` joins the next turn's declarations
        // (scope-allowed AND enabled — the old test's "enabling is still not the same
        // as being allowed" case, now with both halves true).
        expect(declaredNames(seenChild[1])).toEqual(['toolRequest', 'read', 'glob', 'write']);
        expect(writer.discoveredTools).toEqual(['write']);
    });
});

// ---------------------------------------------------------------------------
// 2026-11-09 thread time policy — an omitted `timeoutMs` means NO time limit
// ---------------------------------------------------------------------------
//
// docs/tasks/2026-11-09-thread-timeout-policy.md, R1/R2/R5. The mechanism `delegate`
// gained in T28 survives untouched (the `delegation timeout (T28)` block above is the
// proof, and it passes unmodified); what changed is the DEFAULT:
//
//   - omitted               -> no wall-clock timer is armed at all, and the child
//                              ends on its own answer, however long that takes;
//   - explicit finite value -> armed exactly as before (an opt-in bound);
//   - explicit non-finite   -> the default again, i.e. unbounded, never 0 ms;
//   - the model schema keeps 1..3600000 (it bounds what a MODEL may ask for), while
//                              the unvalidated host path may pass any finite bound
//                              and is NOT clamped.
//
// ---------------------------------------------------------------------------
// The shared "child that hangs on its own tool" scenario
// ---------------------------------------------------------------------------
//
// One builder for the five policy tests below, because every one of them needs the
// SAME shape — a primary that delegates to a researcher whose own tool call parks
// until the test releases it — and they differ only in what the caller passes and
// which observation surface they need:
//
//   - `arguments`      the model-path delegate arguments (the bound under test);
//   - `hostTimeoutMs`  routes the call through a HOST tool body instead, because the
//                      host path (`runtime.delegate`) is the only way to reach a value
//                      JSON cannot carry — an explicit `Infinity`, or a bound above the
//                      schema ceiling — and it bypasses schema validation, which is the
//                      point of T2.3;
//   - `ping: false`    replaces the shipped `async-ping` plugin (the documented
//                      override path), so the ONLY timer that could end the child is
//                      the delegate one and `vi.getTimerCount()` is meaningful;
//   - `wakeIntervalMs` shortens the liveness cadence for the T8 wake tests;
//   - `childMode`      'async' lets the CHILD keep taking turns while its call is
//                      parked (a sync call holds that message's batch gate), which the
//                      wake test needs;
//   - `events`/`seenChild`/`seenParent` the request/event logs a test asserts on.
const hangingChild = (options: {
    arguments: string;
    hostTimeoutMs?: number;
    ping?: false;
    wakeIntervalMs?: number;
    childMode?: 'async';
    events?: HarnessEvent[];
    seenChild?: HarnessStreamRequest[];
    seenParent?: HarnessStreamRequest[];
}) => {
    const gate = deferred<string>();

    const researcher = brain(
        scripted(
            [
                [
                    { type: 'text', delta: 'started the work' },
                    {
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [{ id: 'r1', name: 'hang', arguments: '{}' }]
                    }
                ],
                answer('child finished')
            ],
            options.seenChild
        )
    );

    const writerAgent = brain(
        scripted(
            [
                callTool(
                    'c1',
                    options.hostTimeoutMs === undefined ? 'delegate' : 'hostDelegate',
                    options.arguments
                ),
                answer('waiting'),
                answer('final')
            ],
            options.seenParent
        )
    );

    const hostDelegate = tool({
        description: 'Delegate through the unvalidated host path.',
        tags: ['test'],
        visibility: 'core',
        execute: (context) =>
            context.harness!.runtime.delegate(
                context.agent,
                {
                    agent: 'researcher',
                    input: 'find facts',
                    ...(options.hostTimeoutMs === undefined
                        ? {}
                        : { timeoutMs: options.hostTimeoutMs })
                },
                context.run!,
                context.runDepth,
                context.signal,
                context.callId,
                context.runScope
            )
    });

    const writer = harness({
        agents: { writer: writerAgent, researcher },
        tools: {
            hang: parkedTool('hang', gate.promise, options.childMode),
            ...(options.hostTimeoutMs === undefined ? {} : { hostDelegate })
        },
        presets: false,
        ...(options.wakeIntervalMs === undefined
            ? {}
            : { wakeIntervalMs: options.wakeIntervalMs }),
        ...(options.ping === false
            ? { plugins: [{ name: 'async-ping', setup: () => undefined }] }
            : {}),
        ...(options.events === undefined
            ? {}
            : {
                    report: {
                        progress: (event: HarnessEvent) => {
                            options.events!.push(event);
                        }
                    }
                })
    });

    return { writer, writerAgent, researcher, gate };
};

// Every test here replaces the shipped `async-ping` plugin (the documented override
// path) so the ONLY timer that could end a child is the delegate one, and asserts
// `vi.getTimerCount()` to prove that.
describe('delegation time limits (policy 2026-11-09)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('runs a delegated child with no clock at all when timeoutMs is omitted', async () => {
        const { writer, writerAgent, gate } = hangingChild({
            arguments: '{"agent":"researcher","input":"find facts"}',
            ping: false
        });

        const state = probe(writer('go'));
        await flush();

        // THE CORE ASSERTION: an omitted bound arms no wall-clock timer. Before the
        // policy change this was a 300000 ms timer, so the count was 1 here.
        expect(vi.getTimerCount()).toBe(0);
        expect(writer.thread('agent:researcher')?.status).toBe('running');

        // The OLD default, exactly, and then well past it. Nothing kills the child.
        await advance(300_000);
        expect(state.status).toBe('pending');
        expect(writer.thread('agent:researcher')?.status).toBe('running');
        expect(vi.getTimerCount()).toBe(0);

        await advance(1_500_000);
        expect(state.status).toBe('pending');
        expect(writer.thread('agent:researcher')?.status).toBe('running');

        // It ends because its OWN tool released and it answered — not because a clock
        // fired. The envelope carries no `error`, and the status is the child's own.
        gate.resolve('released');
        await flush();

        expect(state.status).toBe('resolved');
        expect(state.value?.content).toBe('final');

        const result = delegationOf(writerAgent.messages[2]);
        expect(result).toMatchObject({
            agent: 'researcher',
            content: 'child finished',
            status: 'completed'
        });
        expect(result.error).toBeUndefined();
        expect(result.partialContent).toBeUndefined();
        expect(result.cancelledAtMessage).toBeUndefined();
        expect(writer.thread('agent:researcher')?.status).toBe('idle');
    });

    it('treats an explicit non-finite bound as unbounded, never as 0 ms', async () => {
        // `Number.isFinite` rejects Infinity, so an explicit `Infinity` falls through
        // to the default. The default is infinity too now, but this test is the guard
        // against a refactor that turns it into `setTimeout(fn, Infinity)` — which
        // fires immediately and would cancel the child at once.
        const { writer, writerAgent, gate } = hangingChild({
            arguments: '{"agent":"researcher","input":"find facts"}',
            hostTimeoutMs: Number.POSITIVE_INFINITY,
            ping: false
        });

        const state = probe(writer('go'));
        await flush();
        expect(vi.getTimerCount()).toBe(0);

        await advance(3_600_001);
        expect(state.status).toBe('pending');
        expect(writer.thread('agent:researcher')?.status).toBe('running');

        gate.resolve('released');
        await flush();

        expect(state.status).toBe('resolved');
        expect(delegationOf(writerAgent.messages[2])).toMatchObject({
            agent: 'researcher',
            content: 'child finished',
            status: 'completed'
        });
    });

    it('honours a host bound above the model ceiling instead of clamping it', async () => {
        // T2.3: the schema's 3600000 maximum bounds a MODEL argument. A host calling
        // `runtime.delegate` is not schema-validated, and the runtime applies no upper
        // clamp, so a 90-minute bound must still be pending at 3600001 ms. Clamping it
        // silently would cancel the child here — the half-implemented behaviour the
        // policy doc refuses to leave in place.
        const { writer, writerAgent, gate } = hangingChild({
            arguments: '{"agent":"researcher","input":"find facts"}',
            hostTimeoutMs: 5_400_000,
            ping: false
        });

        const state = probe(writer('go'));
        await flush();

        // This path DOES arm exactly one timer: the caller asked for a bound.
        expect(vi.getTimerCount()).toBe(1);

        await advance(3_600_001);
        expect(state.status).toBe('pending');
        expect(writer.thread('agent:researcher')?.status).toBe('running');

        // Past the bound the caller asked for, the T28 mechanism still works: a
        // structured `cancelled` result naming the 5400000 ms bound.
        await advance(1_800_000);
        expect(state.status).toBe('resolved');

        const result = delegationOf(writerAgent.messages[2]);
        expect(result).toMatchObject({
            agent: 'researcher',
            status: 'cancelled',
            content: 'started the work',
            partialContent: 'started the work'
        });
        expect(result.error).toBe(
            'Delegation to "researcher" exceeded its 5400000ms timeout and was stopped.'
        );

        gate.resolve('released');
        await flush();
    });
});

// ---------------------------------------------------------------------------
// The model-facing ceiling: `minimum: 1`, `maximum: 3600000` (T2.2)
// ---------------------------------------------------------------------------
//
// Both bounds are enforced on a MODEL call by the runtime schema gate
// (src/core/schema-validation.ts reads `minimum`/`maximum`), and the refusal happens
// BEFORE the child runs, so the measurement is "the child was never asked". A "0
// means infinity" spelling is rejected on purpose: `minimum: 1` already forbids 0,
// and overloading it would make an explicit value mean "no value".
describe('delegate timeoutMs bounds (policy 2026-11-09)', () => {
    const boundsHarness = (timeoutArgument: string) => {
        const seenChild: HarnessStreamRequest[] = [];
        const researcher = brain(scripted([answer('never started')], seenChild));
        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', `{"agent":"researcher","input":"find facts","timeoutMs":${timeoutArgument}}`),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });

        return { writer, writerAgent, researcher, seenChild };
    };

    it('refuses a model bound above the ceiling before the child runs', async () => {
        const { writer, writerAgent, seenChild } = boundsHarness('4000000');
        const message = await writer('go');

        expect(message.content).toBe('final');
        expect(seenChild).toHaveLength(0);
        expect(content(writerAgent.messages[2])).toBe(
            'Tool "delegate" received arguments that do not match its schema: $.timeoutMs must be <= 3600000.'
        );
    });

    it('refuses a zero bound: the floor is real and 0 does not mean infinity', async () => {
        const { writer, writerAgent, seenChild } = boundsHarness('0');
        const message = await writer('go');

        expect(message.content).toBe('final');
        expect(seenChild).toHaveLength(0);
        expect(content(writerAgent.messages[2])).toBe(
            'Tool "delegate" received arguments that do not match its schema: $.timeoutMs must be >= 1.'
        );
    });
});

// ---------------------------------------------------------------------------
// delegate-stress T1.3/T1.4 — the pending envelope names its own control
// ---------------------------------------------------------------------------
//
// `delegate` tells the model to "use toolCancel with that callId", and the stress run
// found discovery reporting `toolCancel` as absent in exactly that window. The fix
// that removes the discovery dependency entirely: the placeholder the model receives
// while the child runs states the cancellation tool BY NAME, next to the `callId` it
// belongs to. (The sibling half — `toolRequest` reporting `toolCancel` under
// `alreadyAvailable` while a call is in flight — is pinned in
// src/harness.already-available.test.ts.)
describe('pending delegation placeholder (delegate-stress T1.3/T1.4)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('advertises toolCancel beside the callId while the child is still running', async () => {
        const seenParent: HarnessStreamRequest[] = [];
        const { writer, writerAgent, gate } = hangingChild({
            arguments: '{"agent":"researcher","input":"find facts"}',
            ping: false,
            seenParent
        });

        const state = probe(writer('go'));
        await flush();

        // The parent kept working: an async delegation means the NEXT request carries
        // a projection-only placeholder instead of an answer.
        expect(state.status).toBe('pending');
        expect(seenParent).toHaveLength(2);

        const placeholder = (seenParent[1].messages ?? []).find(
            (message) => message.role === 'tool' && message.toolCallId === 'c1'
        ) as Extract<HarnessMessage, { role: 'tool' }>;

        expect({
            role: placeholder.role,
            toolCallId: placeholder.toolCallId,
            name: placeholder.name
        }).toEqual({ role: 'tool', toolCallId: 'c1', name: 'delegate' });

        // Every CONTRACT field, exactly. The free-text `note` is asserted separately
        // because its wording is not the published shape (see the alignment note in
        // src/harness.inclusion.test.ts) — what this finding pins is that the text
        // NAMES the control and the id it belongs to.
        //
        // Issue 0024 (2026-11-14) edited this pin deliberately: the two identity fields are
        // now part of the contract, so they are destructured OUT of the generic payload (which
        // stays exactly the four keys it always was) and asserted against the terminal envelope
        // below rather than against a hard-coded number — the finding is that the placeholder
        // names the SAME child, and an invocation id is a runtime value, not a fixture.
        const { note, invocationId, threadId, ...payload } = JSON.parse(placeholder.content) as {
            status: string;
            callId: string;
            name: string;
            invocationId: string;
            threadId: string;
            elapsedMs: number;
            note: string;
        };
        expect(payload).toEqual({ status: 'pending', callId: 'c1', name: 'delegate', elapsedMs: 0 });
        // The finding is about the NAME: the text the model reads in exactly this
        // moment must point at the control, and the field beside it carries the id.
        expect(note).toContain('toolCancel');

        gate.resolve('released');
        await flush();
        expect(state.status).toBe('resolved');

        // 0024 AC1 — the pending placeholder and the delivered envelope describe ONE child.
        // Before this fix the caller held only `c1` at exactly the moment it might want to
        // inspect the running child, and recovering the ids meant `agentManage`.
        const terminal = delegationOf(writerAgent.messages[2]);

        expect({ invocationId, threadId }).toEqual({
            invocationId: terminal.invocationId,
            threadId: terminal.threadId
        });
    });

    it('gives each of three siblings in flight its own child identity (AC3)', async () => {
        // 0024 AC3 extends the sibling-attribution guarantee (0029) to the PENDING state. Three
        // delegations to ONE agent would serialize behind each other (one model stream per
        // agent), so the interesting shape is three DIFFERENT subagents running at once: each
        // pending placeholder used to carry only its callId, which cannot say which child it
        // describes.
        const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
        const names = ['alpha', 'beta', 'gamma'];

        const children = names.map((name, index) =>
            brain(
                scripted([
                    [
                        { type: 'text', delta: 'working' },
                        {
                            type: 'done',
                            stopReason: 'tool_calls',
                            toolCalls: [{ id: `h${index}`, name: `hang${index}`, arguments: '{}' }]
                        }
                    ],
                    answer(`${name} finished`)
                ])
            )
        );

        const seenParent: HarnessStreamRequest[] = [];

        const writerAgent = brain(
            scripted(
                [
                    [
                        {
                            type: 'done',
                            stopReason: 'tool_calls',
                            toolCalls: names.map((name, index) => ({
                                id: `c${index}`,
                                name: 'delegate',
                                arguments: `{"agent":"${name}","input":"find facts"}`
                            }))
                        }
                    ],
                    answer('waiting'),
                    answer('final')
                ],
                seenParent
            )
        );

        const writer = harness({
            agents: { writer: writerAgent, ...Object.fromEntries(names.map((name, index) => [name, children[index]!])) },
            tools: Object.fromEntries(
                names.map((_, index) => [
                    `hang${index}`,
                    tool({
                        description: 'Park until released.',
                        tags: ['test'],
                        visibility: 'core',
                        execute: () => gates[index]!.promise
                    })
                ])
            ),
            presets: false,
            plugins: [{ name: 'async-ping', setup: () => undefined }]
        });

        const running = writer('go');
        await flush();

        // The second request carries one placeholder per delegated call, and each names its OWN
        // child: three distinct invocation ids, each pointing at its own conversation.
        const placeholders = names.map((_, index) => {
            const message = (seenParent[1]?.messages ?? []).find(
                (entry) => entry.role === 'tool' && entry.toolCallId === `c${index}`
            ) as Extract<HarnessMessage, { role: 'tool' }>;

            expect(message).toBeDefined();

            return JSON.parse(message.content) as {
                status: string;
                callId: string;
                invocationId?: string;
                threadId?: string;
            };
        });

        expect(placeholders.map((entry) => entry.status)).toEqual(['pending', 'pending', 'pending']);
        expect(new Set(placeholders.map((entry) => entry.invocationId)).size).toBe(3);
        expect(placeholders.map((entry) => entry.threadId)).toEqual([
            'agent:alpha',
            'agent:beta',
            'agent:gamma'
        ]);

        for (const gate of gates) gate.resolve('released');
        await flush();
        await running;

        // And each placeholder's id is the id the SAME call is later answered with — the
        // attribution cannot drift between the pending state and the terminal envelope.
        const delivered = names.map((_, index) =>
            delegationOf(
                writerAgent.messages.find(
                    (message) => message.role === 'tool' && message.toolCallId === `c${index}`
                )
            )
        );

        expect(delivered.map((envelope) => envelope.invocationId)).toEqual(
            placeholders.map((placeholder) => placeholder.invocationId)
        );
        expect(delivered.map((envelope) => envelope.content)).toEqual([
            'alpha finished',
            'beta finished',
            'gamma finished'
        ]);
    });
});

// ---------------------------------------------------------------------------
// Policy doc T8 — does the liveness wake actually cover a DELEGATED CHILD?
// ---------------------------------------------------------------------------
//
// With no default clock, the stated recovery for a stuck child is a wake plus an
// explicit `toolCancel`. `async-ping` keys its per-agent timer on scheduler identity
// (src/plugins/async-ping.plugin.ts `arm()`), so whether the CHILD gets its own
// heartbeat — rather than only the parent — was the open question. Both
// configurations are pinned here: plugin on (the shipped default) and plugin replaced
// (a deployment that disables it).
describe('liveness wake covers a delegated child (policy 2026-11-09 T8)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('wakes the CHILD agent while its own tool is parked and offers it toolCancel', async () => {
        const events: HarnessEvent[] = [];
        const seenChild: HarnessStreamRequest[] = [];

        // `childMode: 'async'` is required, not decorative: a SYNC parked call holds
        // that message's batch gate, so the woken run could not take the inspecting
        // turn this test is about.
        const { writer, gate } = hangingChild({
            arguments: '{"agent":"researcher","input":"find facts"}',
            wakeIntervalMs: 250,
            childMode: 'async',
            events,
            seenChild
        });

        const state = probe(writer('go'));
        await flush();

        await advance(249);
        expect(wakeupsFor(events, 'researcher')).toEqual([]);

        await advance(1);
        expect(wakeupsFor(events, 'researcher')).toEqual([
            {
                type: 'wakeup',
                agent: 'researcher',
                reason: 'pending-tools',
                pending: [{ callId: 'r1', name: 'hang', elapsedMs: 250 }],
                // Attributed to the CHILD's run, not the parent's: thread '2' is the
                // researcher's conversation and `callId: 'c1'` records that the
                // delegation call is what started it.
                thread: { id: '2', callId: 'c1' }
            }
        ]);

        // The wake is actionable, not cosmetic: the child's own inspecting request
        // declares the control that releases it.
        const childRequest = seenChild[seenChild.length - 1];
        expect((childRequest.tools ?? []).map((declaration) => declaration.name)).toContain(
            'toolCancel'
        );

        gate.resolve('released');
        await flush();
        expect(state.status).toBe('resolved');
    });

    it('leaves an unbounded child running with no wake when the ping plugin is replaced', async () => {
        const events: HarnessEvent[] = [];
        const { writer, gate } = hangingChild({
            arguments: '{"agent":"researcher","input":"find facts"}',
            childMode: 'async',
            ping: false,
            events
        });

        const state = probe(writer('go'));
        await flush();

        // Three historical intervals with no heartbeat: nothing fires, nothing is
        // armed, and the child is still `running` — which is exactly why the schema
        // text names `toolCancel` as the recovery and keeps `timeoutMs` available.
        await advance(600_000 * 3);
        expect(wakeupsFor(events, 'researcher')).toEqual([]);
        expect(wakeupsFor(events, 'writer')).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
        expect(state.status).toBe('pending');
        expect(writer.thread('agent:researcher')?.status).toBe('running');

        gate.resolve('released');
        await flush();
        expect(state.status).toBe('resolved');
    });
});

// ---------------------------------------------------------------------------
// Per-delegation turn cap (I5 — the COUNT bound a caller sets on one `delegate`)
// ---------------------------------------------------------------------------
//
// `maxTurns` sits next to `timeoutMs` on a single delegation: `timeoutMs` bounds the
// child's wall clock, this bounds its model turns (tool rounds). The contract pinned
// here:
//   - it caps the CHILD's model requests and nothing else, and it is counted, not timed;
//   - an omitted `maxTurns` leaves the harness-wide `maxIterations` limit in charge, and
//     a set value can only LOWER that limit (core/agent-limits.ts:88-90 is the prose,
//     src/harness.ts `runAgentCore` is the enforcement);
//   - running out of turns means the child NEVER ANSWERED, so the envelope keeps the
//     unfinished-run shape (status + partialContent + cancelledAtMessage) rather than
//     presenting a truncated turn as a final answer;
//   - the error text says WHICH bound fired: only the per-run cap adds the
//     "this run was given" suffix, so a caller can tell its own cap from the session's.
//
// Every case goes through an unvalidated HOST tool calling
// `harness.runtime.delegate` directly — the same door the
// `delegation time limits (policy 2026-11-09)` block uses for `timeoutMs`, and the door
// that proves the runtime is not merely relying on schema validation. The model-facing
// door cannot carry `maxTurns` yet: the generated `src/core/tool-manifest.ts` row for
// `delegate` still has ZERO occurrences of the property, so a model argument fails the
// schema's additionalProperties check until `yarn tools:manifest` regenerates that row
// (another task's edit). The model-visible schema is therefore pinned from the tool
// module below, which is the object the manifest row is generated from.
describe('per-delegation turn cap (I5)', () => {
    // A child that never answers: every model turn emits text plus one tool round, so
    // the ONLY thing that can end it is a count bound. Call ids are fresh per turn
    // because re-using one is a hard harness error, not a second round. Pass `answerAt`
    // to have the same child answer on that turn instead — that is how "the cap did not
    // interfere" is told apart from "the cap fired one turn too early".
    const childTurns = (seen: HarnessStreamRequest[], answerAt?: number): HarnessStream => {
        return async function* stream(request) {
            seen.push(request);
            const turn = seen.length;

            if (answerAt !== undefined && turn >= answerAt) {
                for (const frame of answer('an answer')) yield frame;
                return;
            }

            yield { type: 'text', delta: `pass ${turn}` };
            yield {
                type: 'done',
                stopReason: 'tool_calls',
                toolCalls: [{ id: `p${turn}`, name: 'peek', arguments: '{}' }]
            };
        };
    };

    // The host door, mirroring `hangingChild` above: the tool builds the delegate input
    // itself, so a value outside the model schema's 1-64 still reaches the runtime here.
    // Only the two bounds under test are optional; the brief is fixed.
    const cappedChild = (options: {
        seenChild: HarnessStreamRequest[];
        maxTurns?: number;
        maxIterations?: number;
        answerAt?: number;
    }) => {
        const researcher = brain(childTurns(options.seenChild, options.answerAt));
        const writerAgent = brain(scripted([callTool('c1', 'hostDelegate', '{}'), answer('final')]));

        const hostDelegate = tool({
            description: 'Delegate through the unvalidated host path.',
            tags: ['test'],
            visibility: 'core',
            execute: (context) =>
                context.harness!.runtime.delegate(
                    context.agent,
                    {
                        agent: 'researcher',
                        input: 'find facts',
                        ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns })
                    },
                    context.run!,
                    context.runDepth,
                    context.signal,
                    context.callId,
                    context.runScope
                )
        });

        const writer = harness({
            agents: { writer: writerAgent, researcher },
            tools: {
                peek: tool({ description: 'Peek.', tags: ['test'], visibility: 'core', execute: () => 'a fact' }),
                hostDelegate
            },
            presets: false,
            ...(options.maxIterations === undefined ? {} : { maxIterations: options.maxIterations })
        });

        return { writer, writerAgent };
    };

    // The envelope the PARENT was handed, minus `durationMs` — a measured span no
    // assertion here owns (the T28 contract test above pins the identity fields with
    // expect.any). The rest is asserted WHOLE with toEqual, so an extra, missing or
    // renamed field in the unfinished-run shape fails here instead of sliding past a
    // toMatchObject.
    const envelopeOf = (message: unknown): Record<string, unknown> => {
        const { durationMs, ...rest } = delegationOf(message);
        expect(durationMs).toEqual(expect.any(Number));
        return rest;
    };

    it('caps the child at exactly maxTurns model turns and names that cap', async () => {
        const seenChild: HarnessStreamRequest[] = [];
        const { writer, writerAgent } = cappedChild({ maxTurns: 2, seenChild });

        await writer('go');

        // EXACTLY two model requests; the third would have been another tool round.
        // This is the whole point of the cap: bounded work, counted.
        expect(seenChild).toHaveLength(2);

        // A run that runs out of turns ROLLS BACK its own turns, exactly like the
        // harness-wide `maxIterations` guard does, so the child's readable transcript is
        // empty afterwards and the envelope's `partialContent` below is the only
        // surviving evidence of the two turns it did spend. The thread record itself
        // stays addressable (idle, at sequence 2, owned by the requesting thread — that
        // contract belongs to `src/harness.thread-runtime.test.ts`).
        expect(writer.threadMessages('agent:researcher')).toEqual([]);
        expect(writer.thread('agent:researcher')?.sequence).toBe(2);

        // Out of turns means NOT ANSWERED: the unfinished-run envelope, with the
        // per-run suffix "this run was given" marking this cap (not the session
        // limit) as the bound that fired. `content` and `partialContent` are the last
        // turn's text, which is what the child had actually produced.
        expect(envelopeOf(writerAgent.messages[2])).toEqual({
            agent: 'researcher',
            content: 'pass 2',
            contentLength: 6,
            offset: 0,
            limit: 8000,
            truncated: false,
            invocationId: '2',
            threadId: 'agent:researcher',
            status: 'failed',
            error:
                'Agent "researcher" requested tools on all 2 model turns without answering, the maxTurns this run was given.',
            partialContent: 'pass 2',
            cancelledAtMessage: 5
        });

        // The capped child is DATA for the parent, not a failed parent: the parent's own
        // run continues to its answer, and the released child thread is idle again.
        expect(content(writerAgent.messages[3])).toBe('final');
        expect(writer.thread('agent:researcher')?.status).toBe('idle');
    });

    it('falls back to the harness-wide maxIterations when maxTurns is omitted, without naming a run', async () => {
        const seenChild: HarnessStreamRequest[] = [];
        const { writer, writerAgent } = cappedChild({ maxIterations: 3, seenChild });

        await writer('go');

        expect(seenChild).toHaveLength(3);

        // The session bound fired, so the sentence has NO per-run suffix — the reader
        // can tell "my cap" from "the session's cap" from the text alone.
        expect(envelopeOf(writerAgent.messages[2])).toEqual({
            agent: 'researcher',
            content: 'pass 3',
            contentLength: 6,
            offset: 0,
            limit: 8000,
            truncated: false,
            invocationId: '2',
            threadId: 'agent:researcher',
            status: 'failed',
            error: 'Agent "researcher" requested tools on all 3 model turns without answering.',
            partialContent: 'pass 3',
            cancelledAtMessage: 7
        });
    });

    it('only lowers the session bound: maxTurns above maxIterations does not raise it', async () => {
        const seenChild: HarnessStreamRequest[] = [];
        const { writer, writerAgent } = cappedChild({ maxTurns: 9, maxIterations: 2, seenChild });

        await writer('go');

        // A host asking for nine turns against a session limit of two gets two, and the
        // unsuffixed sentence again. `maxTurns` is not a way to buy more work.
        expect(seenChild).toHaveLength(2);
        expect(envelopeOf(writerAgent.messages[2])).toEqual({
            agent: 'researcher',
            content: 'pass 2',
            contentLength: 6,
            offset: 0,
            limit: 8000,
            truncated: false,
            invocationId: '2',
            threadId: 'agent:researcher',
            status: 'failed',
            error: 'Agent "researcher" requested tools on all 2 model turns without answering.',
            partialContent: 'pass 2',
            cancelledAtMessage: 5
        });
    });

    it('leaves a child that answers inside its cap completely alone', async () => {
        const seenChild: HarnessStreamRequest[] = [];
        const { writer, writerAgent } = cappedChild({ maxTurns: 3, answerAt: 2, seenChild });

        await writer('go');

        expect(seenChild).toHaveLength(2);

        // The completed envelope, and the strict toEqual is what proves the ABSENCE of
        // error/partialContent/cancelledAtMessage: a cap that never fired leaves no
        // trace of being a cap at all.
        expect(envelopeOf(writerAgent.messages[2])).toEqual({
            agent: 'researcher',
            content: 'an answer',
            contentLength: 9,
            offset: 0,
            limit: 8000,
            truncated: false,
            invocationId: '2',
            threadId: 'agent:researcher',
            status: 'completed'
        });
    });

    it('cuts a child that would have answered one turn later, and says so in the same shape', async () => {
        const seenChild: HarnessStreamRequest[] = [];
        const { writer, writerAgent } = cappedChild({ maxTurns: 1, answerAt: 2, seenChild });

        await writer('go');

        // The cap is a hard count, not a "let it finish" hint: the answer the child
        // would have produced on turn 2 is never asked for.
        expect(seenChild).toHaveLength(1);
        expect(envelopeOf(writerAgent.messages[2])).toEqual({
            agent: 'researcher',
            content: 'pass 1',
            contentLength: 6,
            offset: 0,
            limit: 8000,
            truncated: false,
            invocationId: '2',
            threadId: 'agent:researcher',
            status: 'failed',
            error:
                'Agent "researcher" requested tools on its single model turn without answering, the maxTurns this run was given.',
            partialContent: 'pass 1',
            cancelledAtMessage: 3
        });
    });

    it('declares the model-facing bounds the schema says: 1-64, optional, unknown keys refused', async () => {
        // Read from the tool module rather than the model door: the generated manifest
        // row is regenerated by another task, and this is the object it is generated
        // from, so the pin holds before and after that regeneration.
        const delegateModule = await import('./tools/runtime/delegate.tool');

        const maxTurnsSchema = {
            type: 'integer',
            minimum: 1,
            maximum: 64,
            description:
                'Optional cap on how many model REQUESTS the child run may make, 1-64. The cap counts model requests, not tool rounds: the child\'s answer has to land inside it, so N allows at most N-1 tool rounds and 1 only suits a child that answers with no tool call at all. OMIT IT to use the harness-wide limit for this session, which is what normally applies; set it to keep a quick lookup cheap or to bound a long research run. A child that runs out of turns has not answered, so its result is reported like any other unfinished run - its status plus the partialContent it had produced - instead of a final answer it never gave.'
        };

        // The catalogue form (no subagents) and the live session declaration are the
        // SAME schema object content: the live one is derived from the literal, so a new
        // delegate argument is written once and both forms advertise it.
        expect(delegateModule.metadata.parameters.properties.maxTurns).toEqual(maxTurnsSchema);
        expect(delegateModule.agentDelegateMetadata(['researcher']).parameters?.properties?.maxTurns).toEqual(
            maxTurnsSchema
        );

        // Optional: `maxTurns` is NOT in `required`, and `additionalProperties: false` is
        // what turns an out-of-range model argument into a refusal instead of a clamp.
        expect(delegateModule.metadata.parameters.required).toEqual(['agent', 'input']);
        expect(delegateModule.metadata.parameters.additionalProperties).toBe(false);
    });
});


// ---------------------------------------------------------------------------
// Policy doc T5.5 — the guard that keeps the policy from rotting
// ---------------------------------------------------------------------------
//
// A source-shape assertion, deliberately: the requirement ("no thread has a
// wall-clock limit") is about what the runtime DOES NOT arm, and the easiest way to
// regress it is a future "safety timeout" bolted onto an unrelated path. Pinning the
// shape means that change has to edit this test on purpose.
describe('harness source shape (policy 2026-11-09 T5.5)', () => {
    const harnessSource = () =>
        readFileSync(fileURLToPath(new URL('./harness.ts', import.meta.url)), 'utf8').split('\n');

    // A line that ARMS something is code; `src/harness.ts` also mentions these names
    // in prose ("Microtasks rather than setTimeout"), so comment lines never count.
    const codeLines = (lines: string[], needle: string) =>
        lines
            .map((line, index) => ({ line, index }))
            .filter(({ line }) => line.includes(needle) && !line.trim().startsWith('//'));

    it('arms exactly one turn-bounding timer, and only behind a finiteness check', () => {
        const lines = harnessSource();

        const armed = codeLines(lines, 'setTimeout(');
        expect(armed).toHaveLength(1);

        // The single arm site is the delegation's, and it is the FIRST statement
        // inside the `Number.isFinite(timeoutMs)` guard — an omitted or non-finite
        // bound therefore arms nothing rather than arming a 0 ms timer.
        expect(armed[0].line).toContain('timeoutTimer = setTimeout(');
        expect(lines[armed[0].index - 1]).toContain('if (Number.isFinite(timeoutMs)) {');

        // And it is cleared behind an existence check, so the unbounded path (no
        // handle) cannot clear a handle that was never created.
        const cleared = codeLines(lines, 'clearTimeout(');
        expect(cleared).toHaveLength(1);
        expect(cleared[0].line).toContain('if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);');

        // The fallback is the exported constant — the single readable place the
        // "no limit by default" fact lives (core/agent-limits.ts, value infinity).
        const fallback = codeLines(lines, ': DELEGATE_TIMEOUT_MS');
        expect(fallback).toHaveLength(1);
    });

    it('arms BOTH opt-in clocks through that one helper, and reads the fork bound it declares', () => {
        const lines = harnessSource();

        // The helper's own arm site is still the ONLY timer in the file, still behind the
        // finiteness check, and its disarm is still guarded by the existence check — the
        // two assertions above, restated against the helper's locals so moving the arm
        // into `armWallClock` cannot silently drop them.
        const armed = codeLines(lines, 'timeoutTimer = setTimeout(');
        expect(armed).toHaveLength(1);
        expect(lines[armed[0].index - 1]).toContain('if (Number.isFinite(timeoutMs)) {');

        const cleared = codeLines(lines, 'if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);');
        expect(cleared).toHaveLength(1);

        // B1: a fork's clock is the SAME mechanism, not a second one. Both doors call the
        // helper and both call the closure it returns, so neither can leak a live timer
        // past its run, and a third clock would have to edit this test on purpose.
        const armedDoors = codeLines(lines, '= armWallClock(');
        expect(armedDoors).toHaveLength(2);
        expect(armedDoors.map(({ line }) => line)).toEqual([
            expect.stringContaining('const disarmWallClock = armWallClock('),
            expect.stringContaining('const disarmWallClock = armWallClock(')
        ]);
        expect(lines.join('\n')).toContain('`Delegation to "${target}"`,');
        expect(lines.join('\n')).toContain('`Thread branch "${metadata.branchId}"`,');

        const disarmed = codeLines(lines, 'disarmWallClock();');
        expect(disarmed).toHaveLength(2);

        // B1, second half: the fork's omitted bound resolves to ONE readable constant
        // (infinity, i.e. no clock) and the harness option that overrides it is actually
        // read. The finding this pins is that `threadForkTimeoutMs` used to be declared
        // and read by nobody, so a host that set it got silence.
        const forkFallback = codeLines(lines, 'const FORK_TIMEOUT_DEFAULT_MS = Number.POSITIVE_INFINITY;');
        expect(forkFallback).toHaveLength(1);

        const forkBound = codeLines(lines, 'resolveForkTimeoutMs(');
        expect(forkBound).toHaveLength(2);
        expect(forkBound.map(({ line }) => line.trim())).toEqual([
            'const threadForkTimeoutMs = resolveForkTimeoutMs(',
            'const forkTimeoutMs = resolveForkTimeoutMs('
        ]);

        // Exactly one read of the configuration field, and it is the line above.
        const configured = codeLines(lines, 'configuration.threadForkTimeoutMs,');
        expect(configured).toHaveLength(1);
    });
});

// Background-runtime races (T12): regression tests for defects found by the
// independent T10 probes. These are BLACK-BOX through the harness API except for
// the scheduler-overwrite guard, which is a direct unit check of the board.
//
// Pinned here:
//   P1-A  a completion that lands while the final model request is in flight —
//         even behind a slow tool_result reporter and even when two completions
//         queue behind one mailbox job — must be inserted, delivered, and force a
//         further turn. The run never returns with a run-owned delivery queued or
//         a stale final answer.
//   P2-A  a delegated child whose transport ignores its abort signal cannot leak
//         text/error frames into a later root run; its committed turns are RETAINED
//         (issue 0036 R1), and a follow-up queued behind it is aborted with the tree.
//   P2-B  duplicate/reused tool-call ids are rejected before any call executes, so
//         only the prompt of the rejected turn is on the record (issue 0036 R1), and
//         the scheduler refuses to overwrite a running task under the same id.
//   Every executed call reports durationMs (including inline calls).
//
// Timing policy: promise gates, never arbitrary tolerance windows. Polling is
// bounded and only waits for a state the harness reaches deterministically.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type {
    Harness,
    HarnessEvent,
    HarnessMessage,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    HarnessToolCall
} from '@underload/harness';
import { createTaskScheduler } from './core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const deferred = <T = void>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
} => {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((settle, fail) => {
        resolve = settle;
        reject = fail;
    });
    return { promise, resolve, reject };
};

// Wait for a predicate the harness will reach deterministically. The bound is a
// failure guard (10s), not a timing assumption.
const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
    for (let attempt = 0; attempt < 1_000; attempt++) {
        if (predicate()) return;
        await sleep(1);
    }
    throw new Error(`Timed out waiting for: ${label}`);
};

// restore() throws while ANY run slot is reserved. A cancelled child's final
// transcript work (the retained tail plus its synthesized answers) lands a microtask
// before its finally decrements that slot, so poll the public operation instead of
// assuming the two land in the same tick. Applying the
// same snapshot repeatedly is idempotent.
const restoreWhenIdle = async (writer: Harness): Promise<void> => {
    for (let attempt = 0; attempt < 1_000; attempt++) {
        try {
            writer.restore(writer.snapshot());
            return;
        } catch {
            await sleep(1);
        }
    }
    throw new Error('restore stayed blocked by an active run');
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const calls = (...requested: HarnessToolCall[]): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: requested }
];

const call = (id: string, name: string, args: string): HarnessToolCall => ({
    id,
    name,
    arguments: args
});

// One transcript entry, compact enough to assert pairing exactly.
const shape = (messages: readonly HarnessMessage[]): string[] =>
    messages.map((message) => {
        if (message.role === 'tool') return `tool:${message.toolCallId}:${message.content}`;
        if (message.role === 'assistant') {
            const ids = (message.toolCalls ?? []).map((entry) => entry.id).join('|');
            return `assistant:${message.content}:${ids}`;
        }
        return `${message.role}:${message.content}`;
    });

// Strict provider pairing: every assistant tool-call block is followed by exactly
// one tool message per call, in call order, with no orphan tool messages.
const wiringIssues = (requests: readonly HarnessStreamRequest[]): string[] => {
    const issues: string[] = [];

    requests.forEach((request, requestIndex) => {
        const claimed = new Set<number>();

        request.messages.forEach((message, index) => {
            if (message.role !== 'assistant') return;
            const requested = message.toolCalls ?? [];
            if (requested.length === 0) return;

            const expected = requested.map((entry) => entry.id);
            const actual: string[] = [];
            let cursor = index + 1;

            while (cursor < request.messages.length && request.messages[cursor].role === 'tool') {
                actual.push((request.messages[cursor] as { toolCallId: string }).toolCallId);
                claimed.add(cursor);
                cursor++;
            }

            if (actual.join(',') !== expected.join(',')) {
                issues.push(
                    `request ${requestIndex} assistant#${index}: expected [${expected.join(',')}] got [${actual.join(',')}]`
                );
            }
        });

        request.messages.forEach((message, index) => {
            if (message.role === 'tool' && !claimed.has(index)) {
                issues.push(`request ${requestIndex} orphan tool:${message.toolCallId}`);
            }
        });
    });

    return issues;
};

// ---------------------------------------------------------------------------
// P1-A — completions racing the final request / a blocked reporter
// ---------------------------------------------------------------------------

describe('completions during the final request (P1-A)', () => {
    it('delivers both overlapping outcomes and rejects a stale final answer', async () => {
        const alphaGate = deferred<string>();
        const betaGate = deferred<string>();
        const requestGate = deferred<void>();
        const reporterGate = deferred<void>();
        const requestStarted = deferred<void>();
        const alphaReporting = deferred<void>();

        const events: HarnessEvent[] = [];
        const seen: HarnessStreamRequest[] = [];
        const guard = { active: 0, max: 0 };
        let turnIndex = 0;

        const stream: HarnessStream = async function* stream(request) {
            const turn = turnIndex++;
            seen.push(JSON.parse(JSON.stringify(request)) as HarnessStreamRequest);

            guard.active++;
            guard.max = Math.max(guard.max, guard.active);

            try {
                if (turn === 0) {
                    for (const frame of calls(
                        call('a1', 'alpha', '{"value":"A"}'),
                        call('b1', 'beta', '{"value":"B"}')
                    )) {
                        yield frame;
                    }
                    return;
                }

                if (turn === 1) {
                    for (const frame of answer('waiting on both')) yield frame;
                    return;
                }

                if (turn === 2) {
                    requestStarted.resolve();
                    await requestGate.promise;
                    // Generated from the projection BEFORE alpha's result existed.
                    for (const frame of answer('FINAL-WITHOUT-ALPHA')) yield frame;
                    return;
                }

                for (const frame of answer('FINAL-WITH-BOTH')) yield frame;
            } finally {
                guard.active--;
            }
        };

        const writer = harness({
            agents: { writer: agent({ model: 'test/model', stream }) },
            tools: {
                alpha: tool<string, string>({
                    description: 'alpha',
                    tags: ['x'],
                    visibility: 'core',
                    // T2/R2: async — this test pins overlapping ASYNC completions racing
                    // the final request, so the calls must not join a sync batch group.
                    mode: 'async',
                    parameters: { type: 'object', properties: { value: { type: 'string' } } },
                    execute: () => alphaGate.promise
                }),
                beta: tool<string, string>({
                    description: 'beta',
                    tags: ['x'],
                    visibility: 'core',
                    // T2/R2: async (see the alpha tool above).
                    mode: 'async',
                    parameters: { type: 'object', properties: { value: { type: 'string' } } },
                    execute: () => betaGate.promise
                })
            },
            presets: false,
            report: {
                progress: async (event) => {
                    events.push(event);
                    if (event.type === 'tool_result' && event.name === 'alpha') {
                        // The canonical insert already happened; the reporter is the
                        // slow part that used to delay markRunDirty.
                        alphaReporting.resolve();
                        await reporterGate.promise;
                    }
                }
            }
        });

        const state: { status: 'pending' | 'resolved' | 'rejected'; message?: string; error?: unknown } =
            { status: 'pending' };

        void writer('go').then(
            (message) => {
                state.status = 'resolved';
                state.message = message.content;
            },
            (error) => {
                state.status = 'rejected';
                state.error = error;
            }
        );

        // Beta drives the third request while alpha is still running.
        await waitFor(() => seen.length === 2, 'the first pause');
        betaGate.resolve('B-done');
        await requestStarted.promise;

        // Alpha completes during that request; its reporter blocks the mailbox.
        alphaGate.resolve('A-done');
        await alphaReporting.promise;

        // Let the (already stale) response finish. The run must NOT settle while a
        // delivery it owns is still queued behind the blocked reporter.
        requestGate.resolve();
        await sleep(15);
        expect(state.status).toBe('pending');

        reporterGate.resolve();
        await waitFor(() => state.status !== 'pending', 'the corrected final answer');

        expect(state.status).toBe('resolved');
        expect(state.message).toBe('FINAL-WITH-BOTH');
        expect(guard.max).toBe(1);

        // Both outcomes are canonical, in call order, and both were delivered once.
        expect(shape(writer.agent.messages)).toEqual([
            'user:go',
            'assistant::a1|b1',
            'tool:a1:A-done',
            'tool:b1:B-done',
            'assistant:waiting on both:',
            'assistant:FINAL-WITHOUT-ALPHA:',
            'assistant:FINAL-WITH-BOTH:'
        ]);

        const results = events.filter(
            (event) => event.type === 'tool_result' && (event.name === 'alpha' || event.name === 'beta')
        );
        // Delivery order follows settlement (beta drove the turn before alpha
        // landed); CANONICAL order above is call order.
        expect(
            results.map((event) =>
                event.type === 'tool_result' ? `${event.name}:${event.callId}:${event.content}` : ''
            )
        ).toEqual(['beta:b1:B-done', 'alpha:a1:A-done']);

        // The request that produced the corrected final answer saw both results.
        const finalRequest = seen[seen.length - 1];
        expect(shape(finalRequest.messages)).toEqual([
            'user:go',
            'assistant::a1|b1',
            'tool:a1:A-done',
            'tool:b1:B-done',
            'assistant:waiting on both:',
            'assistant:FINAL-WITHOUT-ALPHA:'
        ]);

        // Every request paired its calls, in call order.
        expect(wiringIssues(seen)).toEqual([]);
    });

    it('does not lose a second completion queued behind a blocked reporter', async () => {
        const gateA = deferred<string>();
        const gateB = deferred<string>();
        const gateC = deferred<string>();
        const requestGate = deferred<void>();
        const reporterGate = deferred<void>();
        const requestStarted = deferred<void>();
        const alphaReporting = deferred<void>();

        const events: HarnessEvent[] = [];
        const seen: HarnessStreamRequest[] = [];
        let turnIndex = 0;

        const stream: HarnessStream = async function* stream(request) {
            const turn = turnIndex++;
            seen.push(JSON.parse(JSON.stringify(request)) as HarnessStreamRequest);

            if (turn === 0) {
                for (const frame of calls(
                    call('a1', 'alpha', '{"value":"A"}'),
                    call('b1', 'beta', '{"value":"B"}'),
                    call('c1', 'gamma', '{"value":"C"}')
                )) {
                    yield frame;
                }
                return;
            }

            if (turn === 1) {
                for (const frame of answer('waiting')) yield frame;
                return;
            }

            if (turn === 2) {
                requestStarted.resolve();
                await requestGate.promise;
                for (const frame of answer('FINAL-WITHOUT-A-B')) yield frame;
                return;
            }

            for (const frame of answer('FINAL-WITH-A-B')) yield frame;
        };

        const writer = harness({
            agents: { writer: agent({ model: 'test/model', stream }) },
            tools: {
                alpha: tool<string, string>({
                    description: 'alpha',
                    tags: ['x'],
                    visibility: 'core',
                    // T2/R2: async — three overlapping async completions racing one
                    // another is the behaviour under test here.
                    mode: 'async',
                    parameters: { type: 'object', properties: { value: { type: 'string' } } },
                    execute: () => gateA.promise
                }),
                beta: tool<string, string>({
                    description: 'beta',
                    tags: ['x'],
                    visibility: 'core',
                    // T2/R2: async (see the alpha tool above).
                    mode: 'async',
                    parameters: { type: 'object', properties: { value: { type: 'string' } } },
                    execute: () => gateB.promise
                }),
                gamma: tool<string, string>({
                    description: 'gamma',
                    tags: ['x'],
                    visibility: 'core',
                    // T2/R2: async (see the alpha tool above).
                    mode: 'async',
                    parameters: { type: 'object', properties: { value: { type: 'string' } } },
                    execute: () => gateC.promise
                })
            },
            presets: false,
            report: {
                progress: async (event) => {
                    events.push(event);
                    if (event.type === 'tool_result' && event.name === 'alpha') {
                        alphaReporting.resolve();
                        await reporterGate.promise;
                    }
                }
            }
        });

        const state: { status: 'pending' | 'resolved' | 'rejected'; message?: string } = {
            status: 'pending'
        };

        void writer('go').then(
            (message) => {
                state.status = 'resolved';
                state.message = message.content;
            },
            () => {
                state.status = 'rejected';
            }
        );

        await waitFor(() => seen.length === 2, 'the first pause');
        gateC.resolve('C-done');
        await requestStarted.promise;

        // Alpha blocks the mailbox; beta queues behind it. Both land while the
        // request is in flight.
        gateA.resolve('A-done');
        await alphaReporting.promise;
        gateB.resolve('B-done');
        await sleep(10);

        requestGate.resolve();
        await sleep(15);
        expect(state.status).toBe('pending');

        reporterGate.resolve();
        await waitFor(() => state.status !== 'pending', 'the corrected final answer');

        expect(state.status).toBe('resolved');
        expect(state.message).toBe('FINAL-WITH-A-B');

        const delivered = events
            .filter((event) => event.type === 'tool_result')
            .map((event) => (event.type === 'tool_result' ? `${event.name}:${event.content}` : ''));
        expect(delivered).toEqual(['gamma:C-done', 'alpha:A-done', 'beta:B-done']);

        const tools = writer.agent.messages.filter((message) => message.role === 'tool');
        expect(
            tools.map((message) => (message.role === 'tool' ? `${message.toolCallId}:${message.content}` : ''))
        ).toEqual(['a1:A-done', 'b1:B-done', 'c1:C-done']);

        expect(wiringIssues(seen)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// P2-A — late child frames after a parent abort
// ---------------------------------------------------------------------------

describe('delegated child ownership after abort (P2-A)', () => {
    it('suppresses late child events, keeps the cut-off child prompt, and aborts a queued followup', async () => {
        const childGate = deferred<void>();
        const events: HarnessEvent[] = [];
        let childRequests = 0;

        const childStream: HarnessStream = async function* childStream() {
            childRequests++;
            // Deliberately ignores request.signal: the harness cannot preempt it.
            await childGate.promise;
            yield { type: 'text', delta: 'LATE-CHILD-TEXT' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        let primaryTurn = 0;
        let delegateCalls = 0;
        const primaryStream: HarnessStream = async function* primaryStream() {
            const turn = primaryTurn++;

            if (turn === 0) {
                delegateCalls++;
                for (const frame of calls(
                    call('d1', 'delegate', '{"agent":"child","input":"one"}'),
                    call('d2', 'delegate', '{"agent":"child","input":"two"}')
                )) {
                    yield frame;
                }
                return;
            }

            if (turn === 1) {
                for (const frame of answer('primary-paused')) yield frame;
                return;
            }

            for (const frame of answer('second-root-answer')) yield frame;
        };

        const writer = harness({
            agents: {
                primary: agent({ model: 'test/model', stream: primaryStream }),
                child: agent({ model: 'test/model', stream: childStream })
            },
            primary: 'primary',
            subagents: ['child'],
            presets: false,
            report: {
                progress: (event) => {
                    events.push(event);
                }
            }
        });

        const controller = new AbortController();
        let firstError: Error | undefined;

        const first = writer('go', { signal: controller.signal }).then(
            () => undefined,
            (error: unknown) => {
                firstError = error as Error;
                return undefined;
            }
        );

        await waitFor(() => events.some((event) => event.type === 'tool_call'), 'delegation launch');
        controller.abort(new Error('root abort'));
        await first;

        expect(firstError?.message).toContain('root abort');

        // Frames recorded after the abort must never include the child.
        const eventsAfterAbort = events.length;

        const second = await writer('next');
        expect(second.content).toBe('second-root-answer');
        expect(delegateCalls).toBe(1);

        // Release the uncooperative child AFTER the next root run finished.
        childGate.resolve();
        await sleep(60);

        const late = events.slice(eventsAfterAbort);
        expect(late.filter((event) => event.agent === 'child')).toEqual([]);
        expect(late.filter((event) => event.type === 'error')).toEqual([]);

        // Only the aborted first request ever reached the child. Issue 0036 R1 RETAINS
        // the prompt that request carried: a delegated child run is a thread-bound run,
        // so the parent's abort no longer splices its committed turns away. The scripted
        // provider never returned, so no assistant turn was committed and the repair pass
        // had nothing to answer — the child holds EXACTLY that one prompt, no late answer.
        expect(childRequests).toBe(1);
        expect(writer.agents.child.messages).toMatchObject([{ role: 'user', content: 'one' }]);
        // Issue 0036 R1 turns this into a growth check, and the intent survives exactly:
        // the frames recorded after the abort still belong to the child NOWHERE, and the
        // primary's transcript is the retained cut-off work plus the clean second run —
        // nothing from the late child. Re-captured from an actual run: the prompt, the
        // delegation turn whose two calls were never answered (so each carries ONE
        // synthesized interrupted marker, which is what keeps the tail replayable), the
        // follow-up run's committed answer, then the second root run's own two rows.
        // `shape` embeds tool CONTENT, so it would pin the interrupted wording; the rows
        // are asserted structurally instead, with the markers matched by substring only.
        expect(writer.agent.messages).toMatchObject([
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'd1', name: 'delegate', arguments: '{"agent":"child","input":"one"}' },
                    { id: 'd2', name: 'delegate', arguments: '{"agent":"child","input":"two"}' }
                ]
            },
            {
                role: 'tool',
                toolCallId: 'd1',
                name: 'delegate',
                content: expect.stringContaining('cancelled or interrupted')
            },
            {
                role: 'tool',
                toolCallId: 'd2',
                name: 'delegate',
                content: expect.stringContaining('cancelled or interrupted')
            },
            { role: 'assistant', content: 'primary-paused' },
            { role: 'user', content: 'next' },
            { role: 'assistant', content: 'second-root-answer' }
        ]);
    });
});

// ---------------------------------------------------------------------------
// P2-B — malformed / aliased tool-call ids
// ---------------------------------------------------------------------------

describe('tool-call id integrity (P2-B)', () => {
    it('rejects a duplicate-id turn before executing anything, then accepts a clean turn', async () => {
        const executed: string[] = [];
        const events: HarnessEvent[] = [];
        const seen: HarnessStreamRequest[] = [];
        let turnIndex = 0;

        const stream: HarnessStream = async function* stream(request) {
            const turn = turnIndex++;
            seen.push(JSON.parse(JSON.stringify(request)) as HarnessStreamRequest);

            if (turn === 0) {
                // Same id on two different tools: scheduler/canonical aliasing.
                for (const frame of calls(
                    call('dup', 'alpha', '{"value":"A"}'),
                    call('dup', 'beta', '{"value":"B"}')
                )) {
                    yield frame;
                }
                return;
            }

            if (turn === 1) {
                for (const frame of calls(call('ok1', 'alpha', '{"value":"C"}'))) yield frame;
                return;
            }

            if (turn === 2) {
                for (const frame of answer('clean answer')) yield frame;
                return;
            }

            // Third call reuses the id from the successful turn.
            if (turn === 3) {
                for (const frame of calls(call('ok1', 'alpha', '{"value":"D"}'))) yield frame;
                return;
            }

            for (const frame of answer('never')) yield frame;
        };

        const alpha = tool<string, string>({
            description: 'alpha',
            tags: ['x'],
            visibility: 'core',
            parameters: { type: 'object', properties: { value: { type: 'string' } } },
            execute: ({ parameters }) => {
                executed.push(`alpha:${parameters}`);
                return `alpha:${parameters}`;
            }
        });
        const beta = tool<string, string>({
            description: 'beta',
            tags: ['x'],
            visibility: 'core',
            parameters: { type: 'object', properties: { value: { type: 'string' } } },
            execute: ({ parameters }) => {
                executed.push(`beta:${parameters}`);
                return `beta:${parameters}`;
            }
        });

        const writer = harness({
            agents: { writer: agent({ model: 'test/model', stream }) },
            tools: { alpha, beta },
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        await expect(writer('go')).rejects.toThrow(
            'requested tool call id "dup" more than once in one turn'
        );

        // Nothing executed and no tool_call event fired, so the malformed turn is the
        // only thing the rejected run committed: issue 0036 R1 retains the prompt it was
        // built from (the assistant turn was rejected before it was written, so there is
        // no dangling call to repair here either).
        expect(executed).toEqual([]);
        expect(events.filter((event) => event.type === 'tool_call')).toEqual([]);
        expect(writer.agent.messages).toMatchObject([{ role: 'user', content: 'go' }]);

        // The same harness succeeds on a clean turn.
        const clean = await writer('go');
        expect(clean.content).toBe('clean answer');
        expect(executed).toEqual(['alpha:C']);
        // The clean run's own three rows now sit BEHIND the retained prompt of the
        // rejected turn — re-captured from an actual run, and the successful exchange
        // itself is byte-for-byte what it was.
        expect(shape(writer.agent.messages)).toEqual([
            'user:go',
            'user:go',
            'assistant::ok1',
            'tool:ok1:alpha:C',
            'assistant:clean answer:'
        ]);

        // Cross-turn reuse of a committed id is rejected too, and leaves the
        // previous successful transcript untouched: the rejected call adds no
        // assistant turn and no tool row, only the prompt its run committed.
        await expect(writer('go')).rejects.toThrow(
            'reused tool call id "ok1" from an earlier turn'
        );
        expect(executed).toEqual(['alpha:C']);
        expect(shape(writer.agent.messages)).toEqual([
            'user:go',
            'user:go',
            'assistant::ok1',
            'tool:ok1:alpha:C',
            'assistant:clean answer:',
            'user:go'
        ]);
        expect(wiringIssues(seen)).toEqual([]);
    });

    it('refuses to overwrite an in-flight scheduler task under the same id', async () => {
        const wakeups: string[] = [];
        const gate = deferred<string>();
        const scheduler = createTaskScheduler({
            onWake: (agentName) => void wakeups.push(agentName)
        });

        try {
            scheduler.schedule({
                scope: 'run',
                agent: 'writer',
                callId: 'same',
                name: 'held',
                run: () => gate.promise,
                onSettled: () => undefined
            });

            expect(() =>
                scheduler.schedule({
                    scope: 'run',
                    agent: 'writer',
                    callId: 'same',
                    name: 'shadow',
                    run: async () => 'shadow',
                    onSettled: () => undefined
                })
            ).toThrow('is already running in this run; refusing to overwrite');

            expect(scheduler.pendingOfScope('run').map((task) => task.name)).toEqual(['held']);
        } finally {
            scheduler.dispose();
        }

        gate.resolve('held-done');
        expect(wakeups).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// T15 — cancellation liveness: a provider that never returns must not reserve
// the child actor forever, and a late return must not commit into a later run.
// ---------------------------------------------------------------------------

describe('preemptive cancellation of a stuck child (T15)', () => {
    it('releases the child slot so restore, a new root run, and a new delegation all proceed', async () => {
        const events: HarnessEvent[] = [];
        let primaryTurn = 0;
        let childStarts = 0;

        const childStream: HarnessStream = async function* childStream() {
            childStarts++;
            // Ignores its signal and never settles: the harness cannot preempt the
            // provider, but must release the logical run.
            await new Promise<void>(() => undefined);
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const delegate = (id: string): HarnessStreamEvent[] => [
            {
                type: 'done',
                stopReason: 'tool_calls',
                toolCalls: [{ id, name: 'delegate', arguments: '{"agent":"child","input":"work"}' }]
            }
        ];

        const primaryStream: HarnessStream = async function* primaryStream() {
            const turn = primaryTurn++;
            if (turn === 0) {
                for (const frame of delegate('d1')) yield frame;
                return;
            }
            if (turn === 1) {
                for (const frame of answer('WAITING-1')) yield frame;
                return;
            }
            if (turn === 2) {
                for (const frame of answer('PRIMARY-2')) yield frame;
                return;
            }
            if (turn === 3) {
                for (const frame of delegate('d2')) yield frame;
                return;
            }
            for (const frame of answer('WAITING-3')) yield frame;
        };

        const writer = harness({
            agents: {
                primary: agent({ model: 'test/model', stream: primaryStream }),
                child: agent({ model: 'test/model', stream: childStream })
            },
            primary: 'primary',
            subagents: ['child'],
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        const firstController = new AbortController();
        const first = writer('go', { signal: firstController.signal }).then(
            () => 'resolved',
            () => 'rejected'
        );

        await waitFor(() => childStarts === 1, 'the first child request');
        firstController.abort(new Error('root abort'));
        expect(await first).toBe('rejected');

        // The child released its run slot. `restoreWhenIdle` polls restore(), which
        // throws while ANY slot is reserved, so it is the barrier for "no run attached" —
        // and the only honest one now: with retention (issue 0036 R1) the child's
        // transcript never returns to length 0, so the old "child rollback" wait on
        // `messages.length === 0` could never fire. Cancellation is synchronous on the
        // signal; the child's final transcript work lands on the microtask queue just
        // after the root rejection.
        await restoreWhenIdle(writer);
        // The aborted prompt SURVIVES into the snapshot: that is the point of retention —
        // a host restoring this harness can see the work the child was cut off on. The
        // child never produced an assistant turn (its provider never returned), so the
        // repair pass had nothing to answer and the retained tail is this one prompt.
        expect(writer.snapshot().agents.child.messages).toMatchObject([
            { role: 'user', content: 'work' }
        ]);

        // An unrelated root run of the primary proceeds.
        const second = await writer('next');
        expect(second.content).toBe('PRIMARY-2');

        // A NEW delegation to the same child actually starts another request.
        const thirdController = new AbortController();
        const third = writer('again', { signal: thirdController.signal }).then(
            () => 'resolved',
            () => 'rejected'
        );

        await waitFor(() => childStarts === 2, 'reuse of the child slot');
        thirdController.abort(new Error('second abort'));
        expect(await third).toBe('rejected');

        // The slot is released just as promptly the second time, and restore is allowed.
        // "No dangling prompt" becomes "the SECOND cut-off prompt is retained beside the
        // first": retention is per run, so nothing is lost and nothing is rewritten.
        await restoreWhenIdle(writer);
        expect(writer.snapshot().agents.child.messages).toMatchObject([
            { role: 'user', content: 'work' },
            { role: 'user', content: 'work' }
        ]);
    });

    it('discards a late provider completion without touching the later child run', async () => {
        const lateGate = deferred<void>();
        const secondGate = deferred<void>();
        const events: HarnessEvent[] = [];
        let childStarts = 0;
        let primaryTurn = 0;
        let abortIndex = 0;

        const childStream: HarnessStream = async function* childStream() {
            const invocation = ++childStarts;

            if (invocation === 1) {
                // Ignores the abort and returns LATER, after a new run began.
                await lateGate.promise;
                yield { type: 'text', delta: 'LATE-FIRST-TEXT' };
                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                return;
            }

            await secondGate.promise;
            yield { type: 'text', delta: 'SECOND-CHILD-ANSWER' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const delegate = (id: string, input: string): HarnessStreamEvent[] => [
            {
                type: 'done',
                stopReason: 'tool_calls',
                toolCalls: [
                    { id, name: 'delegate', arguments: `{"agent":"child","input":"${input}"}` }
                ]
            }
        ];

        const primaryStream: HarnessStream = async function* primaryStream() {
            const turn = primaryTurn++;
            if (turn === 0) {
                for (const frame of delegate('d1', 'one')) yield frame;
                return;
            }
            if (turn === 1) {
                for (const frame of answer('WAITING-1')) yield frame;
                return;
            }
            if (turn === 2) {
                for (const frame of delegate('d2', 'two')) yield frame;
                return;
            }
            for (const frame of answer('PRIMARY-DONE')) yield frame;
        };

        const writer = harness({
            agents: {
                primary: agent({ model: 'test/model', stream: primaryStream }),
                child: agent({ model: 'test/model', stream: childStream })
            },
            primary: 'primary',
            subagents: ['child'],
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        const firstController = new AbortController();
        const first = writer('go', { signal: firstController.signal }).then(
            () => 'resolved',
            () => 'rejected'
        );

        await waitFor(() => childStarts === 1, 'the first child request');
        firstController.abort(new Error('root abort'));
        expect(await first).toBe('rejected');
        // No "child rollback" wait here any more: retention (issue 0036 R1) keeps the
        // first prompt, so `messages.length === 0` could never fire. The slot release is
        // what this test waits on, and `restoreWhenIdle` below is exactly that barrier
        // (restore throws while any run slot is reserved).
        abortIndex = events.length;

        // Restore is possible right away even though the first provider is parked.
        await restoreWhenIdle(writer);

        // Second root run delegates to the same child; it really starts.
        const second = writer('next');
        await waitFor(() => childStarts === 2, 'the second child request');

        // The parked first provider now returns. Its frames must be suppressed and
        // its message must not commit (precommit guard).
        lateGate.resolve();
        await sleep(40);

        expect(
            events.slice(abortIndex).filter(
                (event) => event.agent === 'child' && event.type === 'text' && event.delta === 'LATE-FIRST-TEXT'
            )
        ).toEqual([]);

        secondGate.resolve();
        const message = await second;
        expect(message.content).toBe('PRIMARY-DONE');

        // The child transcript now holds BOTH runs: the RETAINED prompt of the cancelled
        // first delegation (issue 0036 R1) and the second run's own exchange. What this
        // test actually pins is unchanged — the late provider's 'LATE-FIRST-TEXT' never
        // committed, so the first prompt stands alone with no answer beside it, while the
        // second run completed normally.
        expect(shape(writer.agents.child.messages)).toEqual([
            'user:one',
            'user:two',
            'assistant:SECOND-CHILD-ANSWER:'
        ]);

        // And the persisted view matches it, late commit suppressed there too.
        expect(shape(writer.snapshot().agents.child.messages)).toEqual([
            'user:one',
            'user:two',
            'assistant:SECOND-CHILD-ANSWER:'
        ]);

        expect(
            events.filter(
                (event) => event.agent === 'child' && event.type === 'text'
            ).map((event) => (event.type === 'text' ? event.delta : ''))
        ).toEqual(['SECOND-CHILD-ANSWER']);
    });
});


// ---------------------------------------------------------------------------
// T18 — abort from inside the final `done` reporter
// ---------------------------------------------------------------------------

describe('abort during terminal done (T18)', () => {
    it('keeps the committed turns and rejects when the done reporter aborts the run', async () => {
        const events: HarnessEvent[] = [];
        const controller = new AbortController();
        let abortOnDone = true;
        let turnIndex = 0;

        const stream: HarnessStream = async function* stream() {
            const turn = turnIndex++;
            const text = turn === 0 ? 'FIRST-FINAL' : 'REUSED-ANSWER';
            yield { type: 'text', delta: text };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const writer = harness({
            agents: { writer: agent({ model: 'test/model', stream }) },
            presets: false,
            report: {
                progress: (event) => {
                    events.push(event);
                    // Abort from INSIDE the awaited terminal reporter: the pre-emit
                    // check cannot see it, so a post-emit guard is required.
                    if (event.type === 'done' && abortOnDone) {
                        abortOnDone = false;
                        controller.abort(new Error('abort-during-final-done'));
                    }
                }
            }
        });

        await expect(writer('go', { signal: controller.signal })).rejects.toThrow(
            'abort-during-final-done'
        );

        // Issue 0036 R1: the run that was aborted from inside the terminal `done`
        // reporter KEEPS the turns it committed — the prompt and the answer that had
        // already been written. The rejection below is still the caller's signal; what
        // changed is that the committed work is no longer destroyed alongside the run.
        expect(writer.agent.messages).toMatchObject([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'FIRST-FINAL' }
        ]);
        expect(events.map((event) => event.type)).toEqual(['start', 'text', 'done', 'error']);
        expect(events.at(-1)).toEqual({
            type: 'error',
            agent: 'writer',
            error: { message: 'abort-during-final-done' }
        });

        // Safe immediate reuse: the same harness answers the next call, appending to
        // the retained first exchange — re-captured from an actual run.
        const reused = await writer('next');
        expect(reused.content).toBe('REUSED-ANSWER');
        expect(shape(writer.agent.messages)).toEqual([
            'user:go',
            'assistant:FIRST-FINAL:',
            'user:next',
            'assistant:REUSED-ANSWER:'
        ]);
    });
});

describe('durationMs', () => {
    it('reports an authoritative span for a call that settles in the same turn', async () => {
        const events: HarnessEvent[] = [];
        let turnIndex = 0;

        const stream: HarnessStream = async function* stream() {
            const turn = turnIndex++;
            if (turn === 0) {
                for (const frame of calls(call('i1', 'echo', '{"value":"hi"}'))) yield frame;
                return;
            }
            for (const frame of answer('done')) yield frame;
        };

        const writer = harness({
            agents: { writer: agent({ model: 'test/model', stream }) },
            tools: {
                echo: tool<string, string>({
                    description: 'echo',
                    tags: ['x'],
                    visibility: 'core',
                    parameters: { type: 'object', properties: { value: { type: 'string' } } },
                    execute: ({ parameters }) => parameters
                })
            },
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        await writer('go');

        const result = events.find((event) => event.type === 'tool_result');
        expect(result).toMatchObject({
            type: 'tool_result',
            agent: 'writer',
            name: 'echo',
            callId: 'i1',
            content: 'hi',
            isError: false
        });
        expect((result as { durationMs?: unknown }).durationMs).toEqual(expect.any(Number));
        expect((result as { durationMs?: number }).durationMs).toBeGreaterThanOrEqual(0);
    });
});

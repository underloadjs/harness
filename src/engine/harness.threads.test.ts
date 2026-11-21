// Invocation identity (T3 UI threads): every event of a NON-ROOT run carries a
// `thread` that lets a client group one delegated invocation into a row, indent it
// under its parent, and anchor it to the tool call that spawned it.
//
// Contract pinned here (frozen additive shape, see src/types/index.ts):
//   R1  A child run has a stable id for its whole invocation, and two sequential
//       delegations to the SAME agent get DIFFERENT ids (the run sequence is
//       monotonic per harness), so rows never merge.
//   R2  Lineage: `callId` is the spawning tool call, `input` is the child prompt on
//       `start` only, and `parentId` is absent for a direct child of the root
//       (the runtime caps nesting at MAX_RUN_DEPTH = 2, so a deeper thread can
//       only arrive from recorded state — the shape supports it).
//   R3  Identity survives the whole invocation: start/text/tool_call/tool_result/
//       usage/done/error all name the same thread id, including a pause (`done`
//       with `pending`) and the final answer after a background call settles.
//   R4  Runtime behaviour is unchanged: a cancelled tree emits no child frames (no
//       late thread can land in the next session), and root events keep the exact
//       pre-thread shape (no `thread` key at all).
//   R5  T-W8: every mint also stamps `epoch`, the id of the PROCESS that minted the
//       invocation (./core/agent-limits.ts `HARNESS_PROCESS_EPOCH`), so a recycled id from a
//       restarted runtime can never be mistaken for the run it used to name
//       (./server/turn-projector.ts `isEpochBoundary`).
//
// Clock policy: fake timers own the clock, so launch-relative elapsed/duration
// figures are exact 0s and no real waiting happens.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from './index';
import type { HarnessEvent, HarnessStream, HarnessStreamEvent } from './index';
// T-W8: the WHOLE-payload assertions below name the process epoch. It is asserted against the
// constant (never a literal — it is random BY DESIGN), and it is exact because vitest gives one
// module registry per test file, so this file has exactly one epoch.
import { HARNESS_PROCESS_EPOCH } from './core/agent-limits';

// One scripted frame list per request; the last list is reused when a run asks for
// more requests than were scripted.
const scripted = (turns: HarnessStreamEvent[][]): HarnessStream => {
    let index = 0;
    return async function* stream() {
        const frames = turns[index] ?? turns[turns.length - 1];
        index++;
        for (const frame of frames) yield frame;
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const callTool = (id: string, name: string, args: string): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

const brain = (stream: HarnessStream) => agent({ model: 'merge/ds4-flash', stream });

// A promise the test settles explicitly, so a tool stays pending while the child
// pauses with background work.
type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
    readonly settled: boolean;
};

const deferred = <T>(): Deferred<T> => {
    let settle!: (value: T) => void;
    let settled = false;
    const promise = new Promise<T>((resolve) => {
        settle = (value: T) => {
            settled = true;
            resolve(value);
        };
    });
    return {
        promise,
        resolve: settle,
        get settled() {
            return settled;
        }
    };
};

// Drain microtasks and zero-advance timers until the harness chain rests.
const flush = async (): Promise<void> => {
    for (let pass = 0; pass < 16; pass += 1) {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
    }
};

// A compact exact view of one event: agent, type, and the thread fields in a fixed
// order (`-` marks an absent field). Beats a deep diff for a coverage bug.
const threadKey = (event: HarnessEvent): string =>
    event.thread === undefined
        ? '-'
        : [
              event.thread.id,
              event.thread.parentId ?? '-',
              event.thread.callId ?? '-',
              event.thread.input ?? '-'
          ].join('/');

const shape = (event: HarnessEvent): string => `${event.agent}:${event.type}:${threadKey(event)}`;

// Attach handlers immediately so a cancellation rejection never becomes unhandled,
// and expose the settled state to a synchronous assertion.
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

describe('invocation identity (T3 UI threads)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('gives repeated delegation to the same agent distinct, stable ids', async () => {
        const events: HarnessEvent[] = [];

        const helper = brain(scripted([answer('first facts'), answer('second facts')]));
        const lead = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"helper","input":"first task"}'),
                callTool('c2', 'delegate', '{"agent":"helper","input":"second task"}'),
                answer('lead done')
            ])
        );

        const writer = harness({
            agents: { lead, helper },
            entry: 'lead',
            ranks: { lead: 'A', helper: 'B' },
            presets: false,
            report: {
                progress: (event) => {
                    events.push(event);
                }
            }
        });

        await writer('go');

        // Root run = 1, then one child run per delegation (2, 3). The id is stable
        // across every frame of its invocation; `input` appears on `start` only, and
        // `parentId` is absent because both children hang off the root. Each
        // tool-calling request also closes with `attempt_commit` (R3/F1: a tool round
        // never gets a `done`), emitted once the round's call is launched and before
        // its result.
        expect(events.map(shape)).toEqual([
            'lead:start:-',
            'lead:tool_call:-',
            'helper:start:2/-/c1/first task',
            'lead:attempt_commit:-',
            'helper:text:2/-/c1/-',
            'helper:done:2/-/c1/-',
            'lead:tool_result:-',
            'lead:tool_call:-',
            'helper:start:3/-/c2/second task',
            'lead:attempt_commit:-',
            'helper:text:3/-/c2/-',
            'helper:done:3/-/c2/-',
            'lead:tool_result:-',
            'lead:text:-',
            'lead:done:-'
        ]);

        // The start frames are the only events that carry the prompt.
        // T-W8: each payload also names the PROCESS that minted the invocation id
        // (`HarnessThread.epoch`, minted in ./core/agent-limits.ts `HARNESS_PROCESS_EPOCH` and
        // stamped at the run-identity mints in ./harness.ts). Both children are stamped with the
        // SAME epoch — one process minted both — which is what lets ./server/turn-projector.ts
        // fold them as one process's runs and split only across a restart. Exact, because vitest
        // gives one module registry per test file, so the file has exactly one epoch.
        expect(events.filter((event) => event.type === 'start' && event.agent === 'helper')).toEqual([
            {
                type: 'start',
                agent: 'helper',
                model: 'merge/ds4-flash',
                thread: { id: '2', callId: 'c1', input: 'first task', epoch: HARNESS_PROCESS_EPOCH }
            },
            {
                type: 'start',
                agent: 'helper',
                model: 'merge/ds4-flash',
                thread: { id: '3', callId: 'c2', input: 'second task', epoch: HARNESS_PROCESS_EPOCH }
            }
        ]);

        // Legacy shape: every root/lead frame has no `thread` key at all.
        expect(events.filter((event) => event.agent === 'lead').every((event) => !('thread' in event))).toBe(
            true
        );
    });

    it('labels a ctx.run child with the originating tool call', async () => {
        const events: HarnessEvent[] = [];

        const spawn = tool({
            description: 'Run the helper with a fixed prompt.',
            tags: ['agents'],
            visibility: 'core',
            execute: ({ run }) => run!('helper', 'inner prompt')
        });

        const helper = brain(scripted([answer('inner facts')]));
        const lead = brain(scripted([callTool('c9', 'spawn', '{}'), answer('lead done')]));

        const writer = harness({
            agents: { lead, helper },
            // `entry` is a ROUTING choice only. `ctx.run` is threading, not delegation, so it
            // is not rank-restricted and this fixture needs no `ranks` map — which is itself
            // part of what the test pins.
            entry: 'lead',
            tools: { spawn },
            presets: false,
            report: {
                progress: (event) => {
                    events.push(event);
                }
            }
        });

        await writer('go');

        expect(events.map(shape)).toEqual([
            'lead:start:-',
            'lead:tool_call:-',
            'helper:start:2/-/c9/inner prompt',
            'lead:attempt_commit:-',
            'helper:text:2/-/c9/-',
            'helper:done:2/-/c9/-',
            'lead:tool_result:-',
            'lead:text:-',
            'lead:done:-'
        ]);

        // A later frame keeps the identity fields but never repeats `input` — and keeps the
        // epoch of the process that minted them (see the note on the `start` frames above).
        expect(events.find((event) => event.agent === 'helper' && event.type === 'text')).toEqual({
            type: 'text',
            agent: 'helper',
            delta: 'inner facts',
            thread: { id: '2', callId: 'c9', epoch: HARNESS_PROCESS_EPOCH }
        });
    });

    it('keeps one thread id across a paused child and its final answer', async () => {
        const events: HarnessEvent[] = [];
        const gate = deferred<string>();

        const hold = tool({
            description: 'Hold until the test releases it.',
            tags: ['test'],
            visibility: 'core',
            // T2/R2: async on purpose. The test pins a child that ANSWERS while its
            // call is still in flight, which only exists for an async tool: a sync call
            // would hold the batch gate and the pause frames would never be emitted.
            mode: 'async',
            execute: () => gate.promise
        });

        const helper = brain(scripted([callTool('h1', 'hold', '{}'), answer('child finished')]));
        const lead = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"helper","input":"wait for it"}'),
                answer('lead finished')
            ])
        );

        const writer = harness({
            agents: { lead, helper },
            entry: 'lead',
            ranks: { lead: 'A', helper: 'B' },
            tools: { hold },
            presets: false,
            report: {
                progress: (event) => {
                    events.push(event);
                }
            }
        });

        const running = writer('go');
        await flush();

        // The child has answered while its `hold` call is still running, so it is
        // PAUSED: start/tool_call/attempt_commit/text/done all already carry the same
        // thread id (the tool-calling round closes with `attempt_commit` — R3/F1).
        expect(gate.settled).toBe(false);
        expect(events.filter((event) => event.agent === 'helper').map(shape)).toEqual([
            'helper:start:2/-/c1/wait for it',
            'helper:tool_call:2/-/c1/-',
            'helper:attempt_commit:2/-/c1/-',
            'helper:text:2/-/c1/-',
            'helper:done:2/-/c1/-'
        ]);
        expect(events.find((event) => event.agent === 'helper' && event.type === 'done')).toEqual({
            type: 'done',
            agent: 'helper',
            // T-W8: a PAUSED child keeps naming the same run identity — same invocation id, same
            // spawn call, same process epoch — across the pause and the tool that resumes it.
            thread: { id: '2', callId: 'c1', epoch: HARNESS_PROCESS_EPOCH },
            message: {
                role: 'assistant',
                content: 'child finished',
                reasoning: '',
                toolCalls: [],
                model: 'merge/ds4-flash',
                stopReason: 'stop'
            },
            pending: [{ callId: 'h1', name: 'hold', elapsedMs: 0 }]
        });

        gate.resolve('held');
        await flush();
        await running;

        // The completion drives the child's last turn; the same thread id follows it
        // through tool_result, text, and the final done. The child's tool-calling
        // request also closes with `attempt_commit` (R3/F1: no `done` for that round).
        expect(events.filter((event) => event.agent === 'helper').map(shape)).toEqual([
            'helper:start:2/-/c1/wait for it',
            'helper:tool_call:2/-/c1/-',
            'helper:attempt_commit:2/-/c1/-',
            'helper:text:2/-/c1/-',
            'helper:done:2/-/c1/-',
            'helper:tool_result:2/-/c1/-',
            'helper:text:2/-/c1/-',
            'helper:done:2/-/c1/-'
        ]);
    });

    it('emits no child frames after the tree is cancelled', async () => {
        const events: HarnessEvent[] = [];
        const gate = deferred<string>();
        const controller = new AbortController();

        const hold = tool({
            description: 'Hold until the test releases it.',
            tags: ['test'],
            visibility: 'core',
            execute: () => gate.promise
        });

        const helper = brain(scripted([callTool('h1', 'hold', '{}'), answer('never')]));
        const lead = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"helper","input":"wait for it"}'),
                answer('never')
            ])
        );

        const writer = harness({
            agents: { lead, helper },
            entry: 'lead',
            ranks: { lead: 'A', helper: 'B' },
            tools: { hold },
            presets: false,
            report: {
                progress: (event) => {
                    events.push(event);
                }
            }
        });

        const state = probe(writer('go', { signal: controller.signal }));
        await flush();
        expect(state.status).toBe('pending');

        const cancelledAt = events.length;
        controller.abort(new Error('run aborted'));
        await flush();

        // Only the ROOT reports the cancellation: the child is silent, so no
        // thread-attributed frame can leak into whatever runs this harness next.
        expect(state.status).toBe('rejected');
        expect(events.slice(cancelledAt).map(shape)).toEqual(['lead:error:-']);

        // A late settlement of the uncooperative tool changes nothing.
        gate.resolve('late');
        await flush();
        expect(events.slice(cancelledAt).map(shape)).toEqual(['lead:error:-']);
    });
});

// R1/R2/R3 runtime: THE QUESTION HOLD — an unsettled `actionRequest` owns its run.
//
// WHY THIS FILE EXISTS (and not just extra rows in src/harness.action-request.test.ts):
// that file pins the ANSWER contract (who answers, what the result says, which frames
// appear in which order). The behaviour pinned here is the opposite axis: what the RUN
// may not do while a question is still open. The old contract let a run that had just
// asked a question keep prompting its model with a `{"status":"pending"}` placeholder for
// its OWN unanswered question (that placeholder is what
// `src/harness.action-request.test.ts:99` filtered out), so the model could answer its own
// question, conclude, or burn its whole turn budget before the owner ever replied.
//
// The contract pinned here:
//   R1 — while a run owns an UNSETTLED action request, the turn loop issues NO further
//        model request for that run: the provider request count is frozen between the
//        question and its answer. Neither a heartbeat wake nor an async sibling's
//        completion may buy a turn (src/harness.ts `waitForActionRequests`).
//   R2 — `actionRequest` is declared `mode:'sync'` AND really joins the message's sync
//        group, so a batch of questions costs ONE turn after the last one settles —
//        exactly the Rust mirror's documented semantics (packages/typecrate/harness/
//        src/store/actions.rs:7-13: "the run that raised the question is blocked inside
//        the tool call until its owner answers").
//        A side effect of the declaration, pinned in test 1 and in
//        `src/harness.background.test.ts`: a board whose only work is a question is no
//        longer ASYNC work, so the `async-ping` plugin stops pinging it
//        (src/plugins/async-ping.plugin.ts `isAsyncPending`: "Nothing is armed for a
//        transition that announces no async work: a ping would either report an empty list
//        or wake a run that a sync group re-enters on its own, and both cost a model
//        turn"). `async.pending` / `async.drained` still fire unchanged; only the periodic
//        wake stops, and the run is held instead of pinged.
//   R3 — the delegate design is unchanged: a child request is answered by the tool-free
//        one-turn owner fork, that fork makes exactly ONE provider request, and the CHILD
//        is likewise held until the fork settles.
//   R6/AC4 — every release door (host answer, host failure/expiry, `toolCancel`, run
//        abort) still settles the call exactly once and lets the run continue.
//
// Determinism: every assertion names an exact count or an exact payload. The provider
// request count is the primary oracle — it is a plain integer the script controls.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type {
    HarnessActionChoice,
    HarnessActionRequestContext,
    HarnessEvent,
    HarnessMessage,
    HarnessStream,
    HarnessStreamRequest
} from '@underload/harness';

// ---------------------------------------------------------------------------
// Script helpers (the same shape src/harness.action-request.test.ts uses).
// ---------------------------------------------------------------------------

// `HarnessStreamEvent` is not part of the barrel this suite's siblings import from, so
// the two literal frame shapes a scripted stream yields are named directly.
type HarnessStreamEventLike =
    | { type: 'text'; delta: string }
    | { type: 'done'; stopReason: 'stop' | 'tool_calls'; toolCalls: unknown[] };

const routed = (
    route: (request: HarnessStreamRequest) => HarnessStreamEventLike[] | Promise<HarnessStreamEventLike[]>,
    seen: HarnessStreamRequest[]
): HarnessStream =>
    async function* stream(request) {
        seen.push(request);
        // Awaited, so a script may hold ONE turn open on a deferred (the owner-fork read
        // in the delegate test) — the shape src/harness.background.test.ts `routedStream`
        // uses. A non-awaited route makes the fork's read fail, not the assertion.
        for (const frame of await route(request)) yield frame;
    };

const answer = (text: string): HarnessStreamEventLike[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const call = (id: string, name: string, args: string): HarnessStreamEventLike[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

const calls = (
    ...toolCalls: Array<{ id: string; name: string; arguments: string }>
): HarnessStreamEventLike[] => [{ type: 'done', stopReason: 'tool_calls', toolCalls }];

const latestUser = (request: HarnessStreamRequest): string => {
    for (let index = request.messages.length - 1; index >= 0; index -= 1) {
        const message = request.messages[index];
        if (message.role === 'user') return message.content;
    }
    return '';
};

// Every tool message content, including a `{"status":"pending"}` placeholder.
const toolContents = (request: HarnessStreamRequest): string[] =>
    request.messages
        .filter((message): message is Extract<HarnessMessage, { role: 'tool' }> => message.role === 'tool')
        .map((message) => message.content);

// Only CANONICAL results: a scripted turn branches on what actually settled.
const realToolContents = (request: HarnessStreamRequest): string[] =>
    toolContents(request).filter((content) => !content.includes('"status":"pending"'));

// The owner-fork directive is recognisable by its instruction, not by agent identity:
// the fork reuses the OWNER's brain, so both the owner's turns and the fork's read go to
// the same scripted stream.
const isDirective = (request: HarnessStreamRequest): boolean =>
    latestUser(request).startsWith('You are the OWNER');

const toolCallIds = (messages: readonly HarnessMessage[]): string[] =>
    messages
        .filter((message): message is Extract<HarnessMessage, { role: 'tool' }> => message.role === 'tool')
        .map((message) => message.toolCallId);

const toolResultContents = (messages: readonly HarnessMessage[]): string[] =>
    messages
        .filter((message): message is Extract<HarnessMessage, { role: 'tool' }> => message.role === 'tool')
        .map((message) => message.content);

const flush = async (): Promise<void> => {
    for (let pass = 0; pass < 32; pass += 1) {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
    }
};

// Moves the clock by an exact amount. The `async-ping` heartbeat (default interval
// 600_000ms) is the one wake that is NOT under the test's hand, and R1 is the rule that
// it must not buy a turn.
const advance = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
};

const wakeupsOf = (events: readonly HarnessEvent[]): Array<Extract<HarnessEvent, { type: 'wakeup' }>> =>
    events.filter((event): event is Extract<HarnessEvent, { type: 'wakeup' }> => event.type === 'wakeup');

const deferred = <T>() => {
    let settle!: (value: T) => void;
    let fail!: (reason: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
        settle = resolve;
        fail = reject;
    });
    return { promise, resolve: settle, reject: fail };
};

// Observes a run's settled state without awaiting it, so a test can prove the run is
// still OPEN while its question is unanswered.
type RunState<T> = { status: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown };

const probe = <T>(promise: Promise<T>): RunState<T> => {
    const state: RunState<T> = { status: 'pending' };
    promise.then(
        (value) => {
            state.status = 'resolved';
            state.value = value;
        },
        (error: unknown) => {
            state.status = 'rejected';
            state.error = error;
        }
    );
    return state;
};

const REQUEST_ARGS = JSON.stringify({
    question: 'Which path should I take?',
    recommended: 'fast',
    options: [
        { id: 'fast', label: 'Fast path', description: 'Ship quickly.' },
        { id: 'slow', label: 'Slow path' }
    ]
});

const SECOND_ARGS = JSON.stringify({
    question: 'Which name should I use?',
    recommended: 'a',
    options: [
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta' }
    ]
});

const brain = (stream: HarnessStream) => agent({ model: 'test/model', stream });

describe('actionRequest question hold (R1/R2/R3)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // AC1 — THE HEADLINE. One root question, answered late. Between the question and the
    // answer the provider is asked EXACTLY zero times, and (the consequence of declaring
    // the call 'sync') the board is not even pinged: a question-only board holds no ASYNC
    // work, so `async-ping` stops its timer and the run is held by the harness instead.
    it('issues no model request between a root question and its answer', async () => {
        const seen: HarnessStreamRequest[] = [];
        const events: HarnessEvent[] = [];
        const handler = deferred<HarnessActionChoice>();
        let asked: HarnessActionRequestContext | undefined;

        const entry = brain(
            routed((request) => {
                const results = realToolContents(request);
                if (results.some((content) => content.includes('"answeredBy"'))) return answer('root done');
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('q1', 'actionRequest', REQUEST_ARGS);
                }
                // R1: this turn must never happen. A run that owns an open question has
                // nothing new to look at, and a request here is the placeholder turn the
                // issue is about.
                return answer('placeholder turn');
            }, seen)
        );

        const writer = harness({
            agents: { writer: entry },
            presets: false,
            interaction: {
                actionRequest: async (context) => {
                    asked = context;
                    return handler.promise;
                }
            },
            report: { progress: (event) => void events.push(event) }
        });

        const state = probe(writer('go'));
        await flush();

        // The question is on the record and unanswered, and the run is still open.
        expect(asked?.request.question).toBe('Which path should I take?');
        expect(events.filter((event) => event.type === 'action_request')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'action_answer')).toHaveLength(0);
        expect(state.status).toBe('pending');

        // R1: EXACTLY the one request that produced the question.
        expect(seen).toHaveLength(1);

        // Ten minutes of a heartbeat-enabled harness, with a board that still OWNS the
        // question: nothing to wake, and nothing to prompt.
        await advance(600_000);

        expect(wakeupsOf(events)).toEqual([]);
        expect(seen).toHaveLength(1);
        expect(state.status).toBe('pending');

        // The answer is the ONLY thing that may start the next turn.
        handler.resolve({ kind: 'option', optionId: 'slow' });
        await flush();

        expect(seen).toHaveLength(2);
        expect(state.status).toBe('resolved');
        expect(state.value).toMatchObject({ content: 'root done' });

        // The turn that follows the answer sees the ANSWER, never a placeholder.
        expect(toolContents(seen[1])).toEqual([
            expect.stringContaining('"answeredBy":"owner"')
        ]);

        // Nothing is left armed: the scheduler owns no clock and the hold mints none.
        expect(vi.getTimerCount()).toBe(0);
    });

    // R1, the hard half: wakes that DO happen. The board also holds an ASYNC call, so the
    // heartbeat is armed and pings, and the async completion has its own wake — and NEITHER
    // may spend a request while the run still owns the question. The results ride the ONE
    // turn that the answer itself starts.
    it('parks a heartbeat wake and an async completion while the question is open', async () => {
        const seen: HarnessStreamRequest[] = [];
        const events: HarnessEvent[] = [];
        const handler = deferred<HarnessActionChoice>();
        const sibling = deferred<string>();

        // A host tool that declares 'async' and stays pending until the test releases it:
        // this is what arms the heartbeat on this board. `visibility: 'core'` so the script
        // can call it without a toolRequest round (the same convention
        // src/harness.sync-async.test.ts's `gated` helper uses).
        const snooze = tool({
            description: 'Holds the board open until the test releases it.',
            tags: ['test'],
            visibility: 'core',
            mode: 'async',
            execute: () => sibling.promise
        });

        const entry = brain(
            routed((request) => {
                const results = realToolContents(request);
                if (
                    results.some((content) => content.includes('"answeredBy"')) &&
                    results.some((content) => content === 'snoozed')
                ) {
                    return answer('both settled');
                }
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return calls(
                        { id: 'q1', name: 'actionRequest', arguments: REQUEST_ARGS },
                        { id: 'c1', name: 'snooze', arguments: '{}' }
                    );
                }
                return answer('placeholder turn');
            }, seen)
        );

        const writer = harness({
            agents: { writer: entry },
            presets: false,
            tools: { snooze },
            interaction: { actionRequest: () => handler.promise },
            report: { progress: (event) => void events.push(event) }
        });

        const state = probe(writer('go'));
        await flush();

        expect(seen).toHaveLength(1);
        expect(state.status).toBe('pending');

        // The heartbeat fires because the board holds ASYNC work (the sibling), so the
        // zero-request claim below is not vacuous: the run WAS woken, twice over — the
        // ping frame, and a real completion two steps later.
        await advance(600_000);

        expect(wakeupsOf(events)).toHaveLength(1);
        expect(wakeupsOf(events)[0]).toMatchObject({
            type: 'wakeup',
            agent: 'writer',
            reason: 'pending-tools',
            pending: [
                { callId: 'q1', name: 'actionRequest', elapsedMs: 600_000 },
                { callId: 'c1', name: 'snooze', elapsedMs: 600_000 }
            ]
        });
        expect(seen).toHaveLength(1);

        // The async completion settles on its own. Historically that wake takes its own
        // turn; while the run owns a question it must not. The result is still committed
        // canonically — it is the REQUEST that is held, never the delivery.
        sibling.resolve('snoozed');
        await flush();

        expect(toolResultContents(entry.messages)).toContain('snoozed');
        expect(seen).toHaveLength(1);
        expect(state.status).toBe('pending');

        handler.resolve({ kind: 'custom', text: 'Split it.' });
        await flush();

        expect(seen).toHaveLength(2);
        expect(state.status).toBe('resolved');
        expect(state.value).toMatchObject({ content: 'both settled' });

        // ONE turn carried BOTH outcomes, in CALL ORDER — the answered question (q1)
        // first, then the async sibling (q2) — and the projection that produced it held
        // no pending placeholder for either call.
        expect(toolContents(seen[1])).toEqual([
            expect.stringContaining('"answeredBy":"owner"'),
            'snoozed'
        ]);
        expect(toolContents(seen[1]).some((content) => content.includes('"status":"pending"'))).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    // R2 — the sync batch is REAL: two questions in ONE assistant message cost ONE model
    // turn after the LAST answer, and the first answer alone starts nothing.
    it('settles a batch of questions as one sync group: the first answer buys no turn', async () => {
        const seen: HarnessStreamRequest[] = [];
        const gates = [deferred<HarnessActionChoice>(), deferred<HarnessActionChoice>()];
        const asked: HarnessActionRequestContext[] = [];

        const entry = brain(
            routed((request) => {
                const results = realToolContents(request);
                if (results.filter((content) => content.includes('"answeredBy"')).length >= 2) {
                    return answer('both done');
                }
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return calls(
                        { id: 'q1', name: 'actionRequest', arguments: REQUEST_ARGS },
                        { id: 'q2', name: 'actionRequest', arguments: SECOND_ARGS }
                    );
                }
                return answer('placeholder turn');
            }, seen)
        );

        const writer = harness({
            agents: { writer: entry },
            presets: false,
            interaction: {
                actionRequest: async (context) => {
                    asked.push(context);
                    // q1 answers from gate 0, q2 from gate 1, in launch order.
                    return gates[asked.length - 1].promise;
                }
            }
        });

        const state = probe(writer('go'));
        await flush();

        expect(asked.map((context) => context.request.question)).toEqual([
            'Which path should I take?',
            'Which name should I use?'
        ]);
        expect(seen).toHaveLength(1);

        // The first answer settles ONE group member. The group still owes q2, so the batch
        // gate holds and no request is issued.
        gates[0].resolve({ kind: 'option', optionId: 'slow' });
        await flush();

        expect(seen).toHaveLength(1);
        expect(state.status).toBe('pending');

        gates[1].resolve({ kind: 'custom', text: 'Call it Beta.' });
        await flush();

        expect(seen).toHaveLength(2);
        expect(state.status).toBe('resolved');
        expect(state.value).toMatchObject({ content: 'both done' });

        // One canonical result per call, in call order, each naming its own answer. The
        // ids are process-minted (see src/harness.ts `launchActionRequest`), so the shape
        // and the per-call distinction are what is exact here.
        expect(toolCallIds(entry.messages)).toEqual(['q1', 'q2']);

        const first = JSON.parse(toolResultContents(entry.messages)[0]);
        const second = JSON.parse(toolResultContents(entry.messages)[1]);

        expect(String(first.requestId)).toMatch(/^request-[0-9a-z]+-[0-9a-z]+-\d+$/);
        expect(String(second.requestId)).toMatch(/^request-[0-9a-z]+-[0-9a-z]+-\d+$/);
        expect(first.requestId).not.toBe(second.requestId);
        expect(first.choice).toEqual({ kind: 'option', optionId: 'slow', label: 'Slow path' });
        expect(first.answeredBy).toBe('owner');
        expect(second.choice).toEqual({ kind: 'custom', text: 'Call it Beta.' });
    });

    // R3 — the DELEGATE design survives unchanged: the child asks, the tool-free owner fork
    // answers with exactly one provider request, and the CHILD is held (zero requests of
    // its own) until the fork settles.
    it('holds a delegated child while its owner fork decides, and the fork answers exactly once', async () => {
        const ownerSeen: HarnessStreamRequest[] = [];
        const childSeen: HarnessStreamRequest[] = [];
        const fork = deferred<string>();
        let directiveRequests = 0;

        const helper = brain(
            routed((request) => {
                const results = realToolContents(request);
                if (results.some((content) => content.includes('"answeredBy":"auto"'))) {
                    return answer('child done');
                }
                if (latestUser(request) === 'do work') return call('q1', 'actionRequest', REQUEST_ARGS);
                return answer('placeholder turn');
            }, childSeen)
        );

        const lead = brain(
            routed((request) => {
                if (isDirective(request)) {
                    directiveRequests += 1;
                    return fork.promise.then(() => answer('option:fast'));
                }

                const results = realToolContents(request);
                if (results.some((content) => content.includes('child done'))) return answer('owner done');
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('d1', 'delegate', '{"agent":"helper","input":"do work"}');
                }
                return answer('waiting');
            }, ownerSeen)
        );

        const writer = harness({
            agents: { writer: lead, helper },
            entry: 'writer',
            presets: false,
            // The host handler is never consulted: this is a CHILD request, so only the
            // owner fork may answer it.
            interaction: { actionRequest: async () => ({ kind: 'option', optionId: 'slow' }) }
        });

        const state = probe(writer('owner start'));
        await flush();

        // The fork was raised and is still deciding: ONE tool-free read of the owner.
        expect(directiveRequests).toBe(1);
        expect(ownerSeen.filter(isDirective)).toHaveLength(1);
        expect(ownerSeen.find(isDirective)?.tools).toEqual([]);

        // R3: the child has issued EXACTLY its question turn. The old contract re-ran it
        // with a pending placeholder for its own open question.
        expect(childSeen).toHaveLength(1);
        expect(state.status).toBe('pending');

        // Time passing (the OWNER's board holds the async `delegate` call, so the
        // heartbeat is live in this conversation) must not buy the child a turn either.
        await advance(600_000);

        expect(childSeen).toHaveLength(1);
        expect(directiveRequests).toBe(1);

        fork.resolve('decided');
        await flush();

        // The fork is still a tool-free, ONE-request read.
        expect(directiveRequests).toBe(1);
        expect(ownerSeen.filter(isDirective)).toHaveLength(1);

        // The child answered once and finished; the owner saw the child's answer once.
        expect(childSeen).toHaveLength(2);
        expect(state.status).toBe('resolved');
        expect(state.value).toMatchObject({ content: 'owner done' });

        const autoBranch = writer.branches()[0];
        expect(autoBranch).toMatchObject({ kind: 'autoanswer', status: 'completed', callId: 'q1' });
        expect(toolResultContents(helper.messages)).toHaveLength(1);
        expect(toolResultContents(helper.messages)[0]).toContain('"answeredBy":"auto"');
    });

    // AC4 — `toolCancel` releases the hold. The handler is ABANDONED (its promise never
    // settles), so the release cannot come from the task's own finally: the cancel door
    // must clear the pending bookkeeping itself, or the run parks forever.
    it('releases the hold when toolCancel cancels the pending question', async () => {
        const seen: HarnessStreamRequest[] = [];
        const events: HarnessEvent[] = [];
        const ownerGate = deferred<HarnessActionChoice>();

        const entry = brain(
            routed((request) => {
                const results = realToolContents(request);
                if (results.some((content) => content.includes('was cancelled before it completed'))) {
                    return answer('cancelled done');
                }
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return calls(
                        { id: 'q1', name: 'actionRequest', arguments: REQUEST_ARGS },
                        { id: 'k2', name: 'toolCancel', arguments: '{"callId":"q1"}' }
                    );
                }
                return answer('placeholder turn');
            }, seen)
        );

        const writer = harness({
            agents: { writer: entry },
            presets: false,
            interaction: { actionRequest: () => ownerGate.promise },
            report: { progress: (event) => void events.push(event) }
        });

        const state = probe(writer('go'));
        await flush();

        expect(state.status).toBe('resolved');
        expect(state.value).toMatchObject({ content: 'cancelled done' });
        expect(seen).toHaveLength(2);

        // The cancelled call settled EXACTLY once, as a cancelled control outcome, and the
        // release was acknowledged by its own receipt.
        expect(toolCallIds(entry.messages)).toEqual(['q1', 'k2']);

        const cancelled = toolResultContents(entry.messages)[0];
        expect(cancelled).toContain('Tool call "actionRequest" (q1) was cancelled before it completed');
        expect(cancelled).not.toContain('answeredBy');
        expect(JSON.parse(toolResultContents(entry.messages)[1])).toEqual({
            cancelled: true,
            callId: 'q1',
            name: 'actionRequest'
        });

        // An abandoned handler must not have produced an answer frame.
        expect(events.filter((event) => event.type === 'action_answer')).toHaveLength(0);
        expect(events.filter((event) => event.type === 'action_request')).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);

        // The abandoned handler may still resolve later; nothing else may happen.
        ownerGate.resolve({ kind: 'option', optionId: 'fast' });
        await flush();
        expect(seen).toHaveLength(2);
        expect(events.filter((event) => event.type === 'action_answer')).toHaveLength(0);
        expect(toolCallIds(entry.messages)).toEqual(['q1', 'k2']);
    });

    // AC4 — the expiry/host-failure door: the handler rejects (a server-side expiry answers
    // its own way), the call fails as one error result, and the run continues.
    it('releases the hold when the owner handler fails, with one failure result and one next turn', async () => {
        const seen: HarnessStreamRequest[] = [];
        const handler = deferred<HarnessActionChoice>();

        const entry = brain(
            routed((request) => {
                const results = realToolContents(request);
                if (results.some((content) => content.includes('owner handler failed'))) {
                    return answer('after expiry');
                }
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('q1', 'actionRequest', REQUEST_ARGS);
                }
                return answer('placeholder turn');
            }, seen)
        );

        const writer = harness({
            agents: { writer: entry },
            presets: false,
            interaction: { actionRequest: () => handler.promise }
        });

        const state = probe(writer('go'));
        await flush();

        expect(seen).toHaveLength(1);
        expect(state.status).toBe('pending');

        handler.reject(new Error('request expired'));
        await flush();

        expect(seen).toHaveLength(2);
        expect(state.status).toBe('resolved');
        expect(state.value).toMatchObject({ content: 'after expiry' });

        expect(toolCallIds(entry.messages)).toEqual(['q1']);
        expect(toolResultContents(entry.messages)[0]).toContain(
            'actionRequest owner handler failed: request expired'
        );
        expect(toolResultContents(entry.messages)[0]).not.toContain('answeredBy');
        expect(vi.getTimerCount()).toBe(0);
    });
});
